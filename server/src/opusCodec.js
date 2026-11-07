// opusscript の wasm 本体 (libopus) を直接使う、Opus のエンコーダー/デコーダー。
//
// opusscript の JS ラッパー (index.js) は使わない。ラッパーは PCM 用バッファを `HEAPU16.subarray(ptr, ...)` で作っているが、
// これは「バイトのアドレス」を「16bit要素の番号」として渡しているため、実際に使われる領域が確保した領域の2倍のアドレスにずれる。
// インスタンスが1つだけなら誰にも当たらず動くが、複数のインスタンス (同時に鳴らす複数の音、複数のサーバー) があると
// 互いのデコーダーの状態を上書きし、libopus の assertion で落ちる。ここでは確保したアドレスをそのまま使う。
//
// ネイティブ側の PCM の受け渡し: 「PCM の1バイト = 16bit 要素1個」。要素数の2倍のバイト数を確保する必要がある。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const OPUS_APPLICATION_AUDIO = 2049
const OPUS_SET_BITRATE = 4002
const MAX_FRAME_SIZE = (48_000 * 60) / 1000 // 60ms (サンプル数/チャンネル)
const MAX_PACKET_SIZE = 1276 * 3

let native = null
/** wasm のインスタンスはプロセスで1つ。確保・解放は下のクラスが責任を持つ */
function loadNative() {
  native ??= require('opusscript/build/opusscript_native_wasm.js')()
  return native
}

export class OpusCodec {
  #m
  #handler
  #channels
  #inOpus
  #outOpus
  #inPcm
  #outPcm
  #pcmElements
  #deleted = false

  /**
   * @param {{ channels?: number, sampleRate?: number, bitrate?: number }} [options]
   */
  constructor({ channels = 2, sampleRate = 48_000, bitrate } = {}) {
    const m = loadNative()
    this.#m = m
    this.#channels = channels
    this.#handler = new m.OpusScriptHandler(sampleRate, channels, OPUS_APPLICATION_AUDIO)
    this.#pcmElements = MAX_FRAME_SIZE * channels * 2
    this.#inOpus = m._malloc(MAX_PACKET_SIZE)
    this.#outOpus = m._malloc(MAX_PACKET_SIZE)
    this.#inPcm = m._malloc(this.#pcmElements * 2)
    this.#outPcm = m._malloc(this.#pcmElements * 2)
    if (bitrate) {
      const result = this.#handler._encoder_ctl(OPUS_SET_BITRATE, bitrate)
      if (result < 0) {
        this.delete()
        throw new Error(`Opus のビットレート設定に失敗しました (${result})`)
      }
    }
  }

  /**
   * s16le のインターリーブ PCM (frameSize サンプル/チャンネル分) を1パケットにする。
   * @param {Buffer} pcm
   * @param {number} frameSize 960 = 20ms
   * @returns {Buffer}
   */
  encode(pcm, frameSize) {
    this.#assertAlive()
    if (pcm.length > this.#pcmElements) throw new Error('PCM が大きすぎます')
    const m = this.#m
    m.HEAPU16.set(pcm, this.#inPcm >> 1)
    const length = this.#handler._encode(this.#inPcm, pcm.length, this.#outOpus, frameSize)
    if (length < 0) throw new Error(`Opus のエンコードに失敗しました (${length})`)
    return Buffer.from(m.HEAPU8.subarray(this.#outOpus, this.#outOpus + length))
  }

  /**
   * 1パケットを s16le のインターリーブ PCM にする。
   * @param {Buffer} packet
   * @returns {Buffer}
   */
  decode(packet) {
    this.#assertAlive()
    if (packet.length > MAX_PACKET_SIZE) throw new Error('Opus パケットが大きすぎます')
    const m = this.#m
    m.HEAPU8.set(packet, this.#inOpus)
    const frames = this.#handler._decode(this.#inOpus, packet.length, this.#outPcm)
    if (frames < 0) throw new Error(`Opus のデコードに失敗しました (${frames})`)
    const start = this.#outPcm >> 1
    return Buffer.from(m.HEAPU16.subarray(start, start + frames * this.#channels * 2))
  }

  /** 確保したメモリを解放する (何度呼んでもよい) */
  delete() {
    if (this.#deleted) return
    this.#deleted = true
    const m = this.#m
    m.OpusScriptHandler.destroy_handler(this.#handler)
    m._free(this.#inOpus)
    m._free(this.#outOpus)
    m._free(this.#inPcm)
    m._free(this.#outPcm)
  }

  #assertAlive() {
    if (this.#deleted) throw new Error('解放済みの Opus コーデックです')
  }
}
