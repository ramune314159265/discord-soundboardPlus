import { OggOpusMuxer } from './oggMuxer.js'
import { FRAME_SAMPLES, SAMPLE_RATE, createOpusScriptEncoder, createWebCodecsEncoder } from './opusEncoders.js'

export const DEFAULT_BITRATE = 96_000

export class AbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortError'
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 48kHz ステレオの PCM を Ogg Opus にエンコードする (DOM非依存なので Node でもテスト可)。
 * WebCodecs が使えればそれを、使えない/失敗したら opusscript にフォールバックする。
 *
 * @param {{
 *   left: Float32Array, right: Float32Array,
 *   bitrate?: number,
 *   signal?: AbortSignal,
 *   onProgress?: (ratio: number) => void,
 *   encoders?: Array<'webcodecs' | 'opusscript'>,
 * }} input
 * @returns {Promise<{ data: Uint8Array, durationMs: number, encoder: string }>}
 */
export async function encodePcmToOgg({
  left,
  right,
  bitrate = DEFAULT_BITRATE,
  signal,
  onProgress,
  encoders = ['webcodecs', 'opusscript'],
}) {
  if (left.length === 0) throw new Error('empty audio')
  let lastError = null
  for (const kind of encoders) {
    try {
      const result = await runEncoder(kind, { left, right, bitrate, signal, onProgress })
      if (result) return result
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      console.warn(`[encode] ${kind} failed, trying next:`, err)
      lastError = err
    }
  }
  throw lastError ?? new Error('このブラウザでは Opus エンコードができません')
}

async function runEncoder(kind, { left, right, bitrate, signal, onProgress }) {
  /** @type {{ data: Uint8Array, samples: number }[]} */
  const packets = []
  const onPacket = (data, samples) => packets.push({ data, samples })

  const encoder =
    kind === 'webcodecs'
      ? await createWebCodecsEncoder({ bitrate, onPacket })
      : await createOpusScriptEncoder({ bitrate, onPacket })
  if (!encoder) return null // この環境では使えない

  try {
    const totalFrames = Math.ceil(left.length / FRAME_SAMPLES)
    const frameL = new Float32Array(FRAME_SAMPLES)
    const frameR = new Float32Array(FRAME_SAMPLES)

    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) throw new AbortError()
      const start = f * FRAME_SAMPLES
      const end = Math.min(start + FRAME_SAMPLES, left.length)
      frameL.fill(0)
      frameR.fill(0)
      frameL.set(left.subarray(start, end))
      frameR.set(right.subarray(start, end))
      await encoder.push(frameL, frameR)

      if (f % 100 === 99) {
        onProgress?.((f + 1) / totalFrames)
        await tick() // UI を固めない
      }
    }
    await encoder.flush()
    if (signal?.aborted) throw new AbortError()
    onProgress?.(1)

    if (packets.length === 0) throw new Error('encoder produced no packets')

    const muxer = new OggOpusMuxer({ channels: 2, inputSampleRate: SAMPLE_RATE, preSkip: encoder.preSkip })
    for (const p of packets) muxer.addPacket(p.data, p.samples)
    const data = muxer.finish(left.length)
    return { data, durationMs: Math.round((left.length / SAMPLE_RATE) * 1000), encoder: encoder.name }
  } finally {
    encoder.close()
  }
}
