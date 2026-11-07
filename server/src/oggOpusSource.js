// Ogg Opus を PCM (48kHz / ステレオ / s16) に少しずつ展開する音源。ffmpeg は使わず opusscript だけで動く。
// ミキサーが 20ms ごとに readFrame() を呼ぶ。1回の展開は1パケット分なので、メモリは音声の長さによらず小さい。

import { OpusCodec } from './opusCodec.js'

export const SAMPLE_RATE = 48_000
export const CHANNELS = 2
/** 20ms 分のサンプル数 (ステレオのインターリーブ) */
export const FRAME_SAMPLES = (SAMPLE_RATE / 50) * CHANNELS

/**
 * Ogg のページをたどって Opus のパケットを取り出す。構造の検証は upload 時の inspectOgg が済ませているので、
 * ここでは「読める範囲を安全に読む」ことだけを行う。
 * @param {Buffer} buf
 * @returns {{ packets: Buffer[], preSkip: number, totalSamples: number | null }}
 */
export function parseOggOpus(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  const packets = []
  let pending = []
  let off = 0
  let lastGranule = -1n

  while (off + 27 <= buf.length) {
    if (buf.toString('latin1', off, off + 4) !== 'OggS') throw new Error('Ogg のページが壊れています')
    const granule = buf.readBigInt64LE(off + 6)
    const segCount = buf[off + 26]
    let pos = off + 27 + segCount
    if (pos > buf.length) throw new Error('Ogg のページが途中で切れています')
    // 前のページから続くパケット(継続フラグ)は pending にそのまま繋がる。ここでは区別する必要がない
    for (let i = 0; i < segCount; i++) {
      const len = buf[off + 27 + i]
      if (pos + len > buf.length) throw new Error('Ogg のページが途中で切れています')
      pending.push(buf.subarray(pos, pos + len))
      pos += len
      if (len < 255) {
        packets.push(pending.length === 1 ? pending[0] : Buffer.concat(pending))
        pending = []
      }
    }
    if (granule !== -1n) lastGranule = granule
    off = pos
  }

  const head = packets[0]
  if (!head || head.length < 19 || head.toString('latin1', 0, 8) !== 'OpusHead') {
    throw new Error('Ogg Opus ではありません')
  }
  const preSkip = head.readUInt16LE(10)
  const totalSamples = lastGranule >= 0n ? Math.max(0, Number(lastGranule) - preSkip) : null
  // packets[0] = OpusHead, packets[1] = OpusTags, それ以降が音声
  return { packets: packets.slice(2), preSkip, totalSamples }
}

export class OggOpusSource {
  #packets
  #index = 0
  /** 先頭から捨てるサンプル数 (フレーム単位。エンコーダーの遅延分) */
  #skip
  /** 残りの出力サンプル数 (フレーム単位)。最後のページの granule から決まる。不明なら null */
  #remaining
  #carry = new Int16Array(0)
  #carryPos = 0
  #decoder = null
  #createDecoder
  #closed = false

  /**
   * @param {Buffer} buf Ogg Opus ファイルの中身
   * @param {{ createDecoder?: () => { decode(packet: Buffer): Buffer, delete(): void } }} [options]
   */
  constructor(buf, { createDecoder = () => new OpusCodec({ channels: CHANNELS, sampleRate: SAMPLE_RATE }) } = {}) {
    const { packets, preSkip, totalSamples } = parseOggOpus(buf)
    if (packets.length === 0) throw new Error('音声データがありません')
    this.#packets = packets
    // 長さ: 最後のページの granule から。無ければパケット数 (1パケット = 20ms と仮定)
    this.durationMs = Math.round(((totalSamples ?? packets.length * (SAMPLE_RATE / 50)) / SAMPLE_RATE) * 1000)
    this.#skip = preSkip
    this.#remaining = totalSamples
    this.#createDecoder = createDecoder
  }

  /**
   * 次の 20ms 分を返す。最後の半端な分は無音で埋める。もう無ければ null。
   * @returns {Int16Array | null}
   */
  readFrame() {
    if (this.#closed) return null
    const out = new Int16Array(FRAME_SAMPLES)
    let filled = 0
    while (filled < FRAME_SAMPLES) {
      if (this.#carryPos >= this.#carry.length && !this.#decodeNext()) break
      const n = Math.min(FRAME_SAMPLES - filled, this.#carry.length - this.#carryPos)
      out.set(this.#carry.subarray(this.#carryPos, this.#carryPos + n), filled)
      this.#carryPos += n
      filled += n
    }
    return filled === 0 ? null : out
  }

  /** デコーダーが確保したメモリを解放する (何度呼んでもよい) */
  close() {
    this.#closed = true
    this.#packets = []
    try {
      this.#decoder?.delete()
    } catch {
      /* noop */
    }
    this.#decoder = null
  }

  /** 次のパケットを展開して #carry に入れる。もう無ければ false */
  #decodeNext() {
    while (this.#index < this.#packets.length && this.#remaining !== 0) {
      const packet = this.#packets[this.#index++]
      if (packet.length === 0) continue
      this.#decoder ??= this.#createDecoder()
      const pcm = this.#decoder.decode(packet)
      let samples = new Int16Array(pcm.length >> 1)
      for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2)

      if (this.#skip > 0) {
        const drop = Math.min(this.#skip, samples.length / CHANNELS)
        this.#skip -= drop
        samples = samples.subarray(drop * CHANNELS)
      }
      if (this.#remaining !== null) {
        const keep = Math.min(this.#remaining, samples.length / CHANNELS)
        this.#remaining -= keep
        samples = samples.subarray(0, keep * CHANNELS)
      }
      if (samples.length === 0) continue
      this.#carry = samples
      this.#carryPos = 0
      return true
    }
    return false
  }
}
