// Ogg/Opus ファイルの軽量な検証。ffmpeg が使えない環境でも壊れたファイルを弾くためのもの。

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

/** Ogg 用 CRC32 (多項式 0x04c11db7、反射なし、初期値0) */
export function oggCrc32(bytes) {
  let crc = 0
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0
  }
  return crc >>> 0
}

/**
 * Ogg Opus バッファを検証して情報を返す。
 * @param {Buffer} buf
 * @returns {{ ok: true, durationMs: number, channels: number, pages: number } | { ok: false, error: string }}
 */
export function inspectOgg(buf) {
  const fail = (error) => ({ ok: false, error })
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  if (buf.length < 64) return fail('file_too_small')

  let off = 0
  let pages = 0
  let preSkip = 0
  let channels = 0
  let lastGranule = -1n
  let sawTags = false
  let sawEos = false

  while (off < buf.length) {
    if (off + 27 > buf.length) return fail('truncated_page_header')
    if (buf.toString('latin1', off, off + 4) !== 'OggS') return fail('bad_capture_pattern')
    if (buf[off + 4] !== 0) return fail('bad_stream_version')

    const headerType = buf[off + 5]
    const granule = buf.readBigInt64LE(off + 6)
    const segCount = buf[off + 26]
    const tableEnd = off + 27 + segCount
    if (tableEnd > buf.length) return fail('truncated_segment_table')

    let bodyLen = 0
    for (let i = 0; i < segCount; i++) bodyLen += buf[off + 27 + i]
    const pageEnd = tableEnd + bodyLen
    if (pageEnd > buf.length) return fail('truncated_page_body')

    // CRC 検証 (CRCフィールドを0として計算)
    const page = Buffer.from(buf.subarray(off, pageEnd))
    const storedCrc = page.readUInt32LE(22)
    page.writeUInt32LE(0, 22)
    if (oggCrc32(page) !== storedCrc) return fail('bad_crc')

    const body = buf.subarray(tableEnd, pageEnd)
    if (pages === 0) {
      if (!(headerType & 0x02)) return fail('first_page_not_bos')
      if (body.length < 19 || body.toString('latin1', 0, 8) !== 'OpusHead') return fail('missing_opus_head')
      if (body[8] >> 4 !== 0) return fail('unsupported_opus_version')
      channels = body[9]
      if (channels < 1 || channels > 2) return fail('unsupported_channel_count')
      preSkip = body.readUInt16LE(10)
    } else if (pages === 1) {
      if (body.length < 8 || body.toString('latin1', 0, 8) !== 'OpusTags') return fail('missing_opus_tags')
      sawTags = true
    } else if (granule !== -1n) {
      lastGranule = granule
    }
    if (headerType & 0x04) sawEos = true

    pages++
    off = pageEnd
  }

  if (!sawTags) return fail('missing_opus_tags')
  if (pages < 3 || lastGranule < 0n) return fail('no_audio_data')
  if (!sawEos) return fail('missing_eos')

  const samples = Number(lastGranule) - preSkip
  if (samples <= 0) return fail('empty_audio')
  return { ok: true, durationMs: Math.round((samples / 48000) * 1000), channels, pages }
}
