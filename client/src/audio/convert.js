// ブラウザ上で任意の音声ファイルを 48kHz ステレオ Ogg Opus に変換する。
//   decodeAudioData → OfflineAudioContext でリサンプル → Opus エンコード → Ogg 化

import { AbortError, DEFAULT_BITRATE, encodePcmToOgg } from './encode.js'
import { SAMPLE_RATE } from './opusEncoders.js'
import { normalizeLoudness } from './loudness.js'

function decodeAudio(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) throw new Error('このブラウザは音声のデコードに対応していません')
  const ctx = new Ctx()
  return new Promise((resolve, reject) => {
    // 古い Safari はコールバック形式のみ、新しいものは Promise 形式。両方に対応する
    const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject)
    if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(resolve, reject)
  }).finally(() => {
    ctx.close?.().catch?.(() => {})
  })
}

async function resampleTo48kStereo(decoded) {
  if (decoded.sampleRate === SAMPLE_RATE && decoded.numberOfChannels === 2) {
    return { left: decoded.getChannelData(0), right: decoded.getChannelData(1) }
  }
  const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE))
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const offline = new OfflineCtx(2, length, SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination) // モノラルは自動的に左右へアップミックスされる
  source.start(0)
  const rendered = await new Promise((resolve, reject) => {
    const p = offline.startRendering()
    if (p && typeof p.then === 'function') p.then(resolve, reject)
    else offline.oncomplete = (e) => resolve(e.renderedBuffer)
  })
  return { left: rendered.getChannelData(0), right: rendered.getChannelData(1) }
}

/**
 * @param {File | Blob} file
 * @param {{ bitrate?: number, signal?: AbortSignal, onProgress?: (p: { phase: 'decoding' | 'encoding', ratio: number }) => void }} [options]
 * @returns {Promise<{ blob: Blob, durationMs: number, encoder: string, gainDb: number }>}
 */
export async function convertToOggOpus(file, { bitrate = DEFAULT_BITRATE, signal, onProgress } = {}) {
  onProgress?.({ phase: 'decoding', ratio: 0 })
  const bytes = await file.arrayBuffer()
  if (signal?.aborted) throw new AbortError()

  let decoded
  try {
    decoded = await decodeAudio(bytes)
  } catch (err) {
    throw new Error('この音声ファイルは読み込めませんでした (対応していない形式の可能性があります)', { cause: err })
  }
  if (signal?.aborted) throw new AbortError()

  const resampled = await resampleTo48kStereo(decoded)
  if (signal?.aborted) throw new AbortError()
  // どんな音声でも同じくらいの大きさになるよう、ラウドネスを揃える
  const { left, right, gainDb } = normalizeLoudness(resampled)
  onProgress?.({ phase: 'decoding', ratio: 1 })

  const result = await encodePcmToOgg({
    left,
    right,
    bitrate,
    signal,
    onProgress: (ratio) => onProgress?.({ phase: 'encoding', ratio }),
  })
  return {
    blob: new Blob([result.data], { type: 'audio/ogg' }),
    durationMs: result.durationMs,
    encoder: result.encoder,
    gainDb,
  }
}
