// Opus パケット列を Ogg コンテナ (RFC 3533 / RFC 7845) に包む最小限の muxer。
// ブラウザ/Node 両対応 (DOM 非依存)。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    }
    table[i] = r >>> 0
  }
  return table
})()

/** Ogg 用 CRC32 (多項式 0x04c11db7、反射なし、初期値 0) */
export function oggCrc32(bytes) {
  let crc = 0
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0
  }
  return crc >>> 0
}

const MAX_SEGMENTS = 255
const MAX_PACKETS_PER_PAGE = 50 // 20ms * 50 = 約1秒ごとにページを区切る

const textEncoder = new TextEncoder()

function segmentsFor(length) {
  // 255 の倍数ちょうどのときも終端用の 0 セグメントが必要
  return Math.floor(length / 255) + 1
}

export class OggOpusMuxer {
  /**
   * @param {{ channels?: number, inputSampleRate?: number, preSkip?: number, serial?: number, vendor?: string }} [options]
   */
  constructor({
    channels = 2,
    inputSampleRate = 48000,
    preSkip = 312,
    serial = (Math.random() * 0xffffffff) >>> 0,
    vendor = 'soundboard-activity',
  } = {}) {
    this.preSkip = preSkip
    this.serial = serial >>> 0
    this.sequence = 0
    /** @type {Uint8Array[]} */
    this.chunks = []
    /** @type {{ data: Uint8Array, samples: number }[]} */
    this.pending = []
    this.pendingSegments = 0
    this.granule = 0
    this.finished = false

    // ページ1: OpusHead (BOS)
    const head = new Uint8Array(19)
    const hv = new DataView(head.buffer)
    head.set(textEncoder.encode('OpusHead'), 0)
    head[8] = 1 // version
    head[9] = channels
    hv.setUint16(10, preSkip, true)
    hv.setUint32(12, inputSampleRate, true)
    hv.setInt16(16, 0, true) // output gain
    head[18] = 0 // channel mapping family 0
    this.#writePage([head], 0, 0x02)

    // ページ2: OpusTags
    const vendorBytes = textEncoder.encode(vendor)
    const tags = new Uint8Array(8 + 4 + vendorBytes.length + 4)
    const tv = new DataView(tags.buffer)
    tags.set(textEncoder.encode('OpusTags'), 0)
    tv.setUint32(8, vendorBytes.length, true)
    tags.set(vendorBytes, 12)
    tv.setUint32(12 + vendorBytes.length, 0, true) // user comment count
    this.#writePage([tags], 0, 0x00)
  }

  /**
   * @param {Uint8Array} data Opus パケット1つ
   * @param {number} samples このパケットが表す 48kHz サンプル数 (20ms なら 960)
   */
  addPacket(data, samples) {
    if (this.finished) throw new Error('muxer already finished')
    const segs = segmentsFor(data.length)
    if (segs > MAX_SEGMENTS) throw new Error('opus packet too large')
    if (
      this.pending.length > 0 &&
      (this.pendingSegments + segs > MAX_SEGMENTS || this.pending.length >= MAX_PACKETS_PER_PAGE)
    ) {
      this.#flushPending(0)
    }
    this.pending.push({ data, samples })
    this.pendingSegments += segs
  }

  /**
   * @param {number} [totalPcmSamples] 元PCMのサンプル数。指定すると末尾のパディングを切り落とす
   * @returns {Uint8Array}
   */
  finish(totalPcmSamples) {
    if (this.finished) throw new Error('muxer already finished')
    if (this.pending.length === 0) throw new Error('no audio packets')
    this.finished = true
    this.#flushPending(0x04, totalPcmSamples)

    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const chunk of this.chunks) {
      out.set(chunk, off)
      off += chunk.length
    }
    return out
  }

  #flushPending(flags, totalPcmSamples) {
    const packets = this.pending
    this.pending = []
    this.pendingSegments = 0
    for (const p of packets) this.granule += p.samples
    let granule = this.granule
    if (flags & 0x04 && totalPcmSamples !== undefined) {
      // 最終ページ: エンコーダ遅延(preSkip) + 実際のPCM長 までに切り詰める
      granule = Math.min(granule, this.preSkip + totalPcmSamples)
    }
    this.#writePage(
      packets.map((p) => p.data),
      granule,
      flags,
    )
  }

  /**
   * @param {Uint8Array[]} packets
   * @param {number} granule
   * @param {number} flags 0x01 continued / 0x02 BOS / 0x04 EOS
   */
  #writePage(packets, granule, flags) {
    const lacing = []
    let bodyLength = 0
    for (const packet of packets) {
      let n = packet.length
      while (n >= 255) {
        lacing.push(255)
        n -= 255
      }
      lacing.push(n)
      bodyLength += packet.length
    }
    if (lacing.length > MAX_SEGMENTS) throw new Error('too many segments in a page')

    const headerLength = 27 + lacing.length
    const page = new Uint8Array(headerLength + bodyLength)
    const view = new DataView(page.buffer)
    page.set(textEncoder.encode('OggS'), 0)
    page[4] = 0 // stream structure version
    page[5] = flags
    // granule position (64bit LE). 2^53 未満なので Number で扱える
    view.setUint32(6, granule % 0x100000000, true)
    view.setUint32(10, Math.floor(granule / 0x100000000), true)
    view.setUint32(14, this.serial, true)
    view.setUint32(18, this.sequence++, true)
    view.setUint32(22, 0, true) // CRC (後で埋める)
    page[26] = lacing.length
    page.set(lacing, 27)

    let off = headerLength
    for (const packet of packets) {
      page.set(packet, off)
      off += packet.length
    }
    view.setUint32(22, oggCrc32(page), true)
    this.chunks.push(page)
  }
}
