// Opus エンコーダ実装2種。どちらも同じインターフェースを返す:
//   { name, preSkip, push(left, right), flush(), close() }
//   - push: 960 サンプル(20ms, 48kHz)の Float32 ステレオ1フレームを渡す
//   - エンコード済みパケットは onPacket(data: Uint8Array, samples: number) で受け取る
//
// 1. WebCodecs の AudioEncoder (Chromium / 新しめの Safari 等)
// 2. opusscript (libopus の asm.js ビルド)。WebCodecs が無い/opus 非対応の WebView 用フォールバック。
//    wasm 版は別ファイル読み込みが必要で Activity のプロキシ配下では扱いにくいため、単一ファイルの asm.js を使う。

export const FRAME_SAMPLES = 960
export const SAMPLE_RATE = 48000
const DEFAULT_PRE_SKIP = 312 // libopus 48kHz のルックアヘッド

/** OpusHead から pre-skip を取り出す (WebCodecs の decoderConfig.description 用) */
function parsePreSkip(description) {
  try {
    const bytes =
      description instanceof ArrayBuffer
        ? new Uint8Array(description)
        : new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    const text = String.fromCharCode(...bytes.subarray(0, 8))
    if (text !== 'OpusHead' || bytes.length < 12) return null
    return bytes[10] | (bytes[11] << 8)
  } catch {
    return null
  }
}

export function isWebCodecsAvailable() {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'
}

/** @returns {Promise<null | ReturnType<typeof makeWebCodecsEncoder>>} 非対応なら null */
export async function createWebCodecsEncoder({ bitrate, onPacket }) {
  if (!isWebCodecsAvailable()) return null

  const base = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate }
  const candidates = [{ ...base, opus: { frameDuration: 20000, application: 'audio' } }, base]
  let config = null
  for (const candidate of candidates) {
    try {
      const support = await AudioEncoder.isConfigSupported(candidate)
      if (support?.supported) {
        config = candidate
        break
      }
    } catch {
      /* 次の候補へ */
    }
  }
  if (!config) return null
  return makeWebCodecsEncoder(config, onPacket)
}

function makeWebCodecsEncoder(config, onPacket) {
  let error = null
  let preSkip = null
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (preSkip === null && metadata?.decoderConfig?.description) {
        preSkip = parsePreSkip(metadata.decoderConfig.description)
      }
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      const samples = chunk.duration ? Math.round((chunk.duration * SAMPLE_RATE) / 1_000_000) : FRAME_SAMPLES
      onPacket(data, samples)
    },
    error: (e) => {
      error = e
    },
  })
  encoder.configure(config)

  let frameIndex = 0
  const planar = new Float32Array(FRAME_SAMPLES * 2)

  return {
    name: 'webcodecs',
    get preSkip() {
      return preSkip ?? DEFAULT_PRE_SKIP
    },
    async push(left, right) {
      if (error) throw error
      planar.set(left, 0)
      planar.set(right, FRAME_SAMPLES)
      const audio = new AudioData({
        format: 'f32-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAME_SAMPLES,
        numberOfChannels: 2,
        timestamp: Math.round((frameIndex * FRAME_SAMPLES * 1_000_000) / SAMPLE_RATE),
        data: planar,
      })
      frameIndex++
      try {
        encoder.encode(audio)
      } finally {
        audio.close()
      }
      // エンコーダのキューが溜まりすぎないよう待つ
      while (encoder.encodeQueueSize > 16) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (error) throw error
      }
    },
    async flush() {
      await encoder.flush()
      if (error) throw error
    },
    close() {
      try {
        encoder.close()
      } catch {
        /* すでに閉じている */
      }
    },
  }
}

/** opusscript (asm.js) を使ったフォールバック */
export async function createOpusScriptEncoder({ bitrate, onPacket }) {
  const mod = await import('opusscript/build/opusscript_native_nasm.js')
  const factory = mod.default ?? mod
  const native = factory()

  const OPUS_APPLICATION_AUDIO = 2049
  const OPUS_SET_BITRATE_REQUEST = 4002
  const MAX_PACKET_SIZE = 1276 * 3

  const handler = new native.OpusScriptHandler(SAMPLE_RATE, 2, OPUS_APPLICATION_AUDIO)
  // opusscript のネイティブ側は「PCM の各バイトを 16bit 要素に1つずつ広げたもの」を入力に取り、
  // 内部で int16 サンプルに組み立てる。そのため入力領域は 1フレームのバイト数 x 2 バイト必要。
  const pcmBytes = FRAME_SAMPLES * 2 * 2
  const inPtr = native._malloc(pcmBytes * 2)
  const outPtr = native._malloc(MAX_PACKET_SIZE)

  const ctl = handler._encoder_ctl(OPUS_SET_BITRATE_REQUEST, bitrate)
  if (ctl < 0) throw new Error(`opus encoder ctl failed: ${ctl}`)

  const widened = new Uint8Array(pcmBytes) // int16 LE のバイト列 (エンディアン非依存で組み立てる)

  return {
    name: 'opusscript',
    preSkip: DEFAULT_PRE_SKIP,
    async push(left, right) {
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const l = floatToInt16(left[i])
        const r = floatToInt16(right[i])
        const o = i * 4
        widened[o] = l & 0xff
        widened[o + 1] = (l >> 8) & 0xff
        widened[o + 2] = r & 0xff
        widened[o + 3] = (r >> 8) & 0xff
      }
      // メモリ拡張で HEAP が差し替わることがあるので毎回 native.HEAPU16 を参照する。
      // 1バイトを1要素として書き込む (inPtr は 8 の倍数なので >> 1 で要素番号に直せる)
      native.HEAPU16.set(widened, inPtr >> 1)
      const length = handler._encode(inPtr, pcmBytes, outPtr, FRAME_SAMPLES)
      if (length < 0) throw new Error(`opus encode failed: ${length}`)
      onPacket(native.HEAPU8.slice(outPtr, outPtr + length), FRAME_SAMPLES)
    },
    async flush() {},
    close() {
      native._free(inPtr)
      native._free(outPtr)
    },
  }
}

function floatToInt16(x) {
  const clamped = x < -1 ? -1 : x > 1 ? 1 : x
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
}
