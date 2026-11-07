import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CEILING_DB, MAX_BOOST_DB, TARGET_LUFS, limitPeaks, measureLoudness, normalizeLoudness } from '../src/audio/loudness.js'

const RATE = 48_000
function tone(seconds, amplitude, freq = 1000, channels = 2) {
  const n = Math.round(seconds * RATE)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE)
    left[i] = v
    right[i] = channels === 2 ? v : 0
  }
  return { left, right }
}
const peak = ({ left, right }) => Math.max(...left.map(Math.abs), ...right.map(Math.abs))
const dbfs = (x) => 20 * Math.log10(x)

test('measureLoudness: a full-scale 1kHz sine on both channels is 0 LUFS (BS.1770 reference), and each 6 dB is 6 LU', () => {
  const loud = measureLoudness(...Object.values(tone(2, 1)))
  assert.ok(Math.abs(loud) < 0.3, `loudness ${loud}`)
  const half = measureLoudness(...Object.values(tone(2, 0.5)))
  assert.ok(Math.abs(loud - half - 6.02) < 0.05)
})

test('measureLoudness: silence is -Infinity, and silent gaps do not drag the level down (gating)', () => {
  assert.equal(measureLoudness(new Float32Array(48_000), new Float32Array(48_000)), -Infinity)
  const sound = tone(1, 0.3)
  const padded = { left: new Float32Array(RATE * 4), right: new Float32Array(RATE * 4) }
  padded.left.set(sound.left, RATE)
  padded.right.set(sound.right, RATE)
  const a = measureLoudness(sound.left, sound.right)
  const b = measureLoudness(padded.left, padded.right)
  // ゲートが無ければ、4秒のうち1秒だけ鳴っているので約 6LU 下がる。ゲートのおかげで境目の影響だけに収まる
  assert.ok(Math.abs(a - b) < 1.5, `${a} vs ${b}`)
})

test('measureLoudness: clips shorter than 400ms still get a value', () => {
  const v = measureLoudness(...Object.values(tone(0.15, 0.3)))
  assert.ok(Number.isFinite(v) && v < 0 && v > -40)
})

test('normalizeLoudness: very quiet and very loud inputs end up at the same loudness', () => {
  const quiet = normalizeLoudness(tone(1.5, 0.02))
  const loud = normalizeLoudness(tone(1.5, 0.8))
  const a = measureLoudness(quiet.left, quiet.right)
  const b = measureLoudness(loud.left, loud.right)
  assert.ok(Math.abs(a - TARGET_LUFS) < 0.3, `quiet -> ${a}`)
  assert.ok(Math.abs(b - TARGET_LUFS) < 0.3 || peak(loud) <= 10 ** (CEILING_DB / 20) + 1e-6, `loud -> ${b}`)
  assert.ok(Math.abs(a - b) < 0.5, `${a} vs ${b}`)
  assert.ok(quiet.gainDb > 0 && loud.gainDb < 0)
})

test('normalizeLoudness: the result never goes above the peak ceiling, and the input arrays are untouched', () => {
  const input = tone(1, 0.9)
  const copy = Float32Array.from(input.left)
  const out = normalizeLoudness(input, { targetLufs: -6 })
  assert.ok(peak(out) <= 10 ** (CEILING_DB / 20) + 1e-6, `peak ${dbfs(peak(out))} dBFS`)
  assert.deepEqual(input.left, copy)
  assert.notEqual(out.left, input.left)
})

test('normalizeLoudness: silence is returned as is, and the boost is capped', () => {
  const silent = { left: new Float32Array(1000), right: new Float32Array(1000) }
  const out = normalizeLoudness(silent)
  assert.equal(out.gainDb, 0)
  assert.equal(out.left, silent.left)
  const whisper = normalizeLoudness(tone(1, 0.0005)) // 約 -66 dBFS
  assert.ok(whisper.gainDb <= MAX_BOOST_DB + 1e-9)
})

test('normalizeLoudness: a short, peaky sound (a click) is limited smoothly instead of clipped', () => {
  const n = RATE
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < 200; i++) {
    left[10_000 + i] = right[10_000 + i] = 0.9 * Math.sin((2 * Math.PI * 800 * i) / RATE) * Math.exp(-i / 60)
  }
  const out = normalizeLoudness({ left, right })
  assert.ok(peak(out) <= 10 ** (CEILING_DB / 20) + 1e-6)
  // 滑らか = 隣り合うサンプルのゲイン比が急に変わらない (切り捨てのような折れ曲がりが無い)
  let maxStep = 0
  for (let i = 10_001; i < 10_200; i++) {
    if (Math.abs(left[i]) > 0.02 && Math.abs(left[i - 1]) > 0.02) {
      const g1 = out.left[i] / left[i]
      const g0 = out.left[i - 1] / left[i - 1]
      maxStep = Math.max(maxStep, Math.abs(g1 - g0) / g0)
    }
  }
  assert.ok(maxStep < 0.02, `gain changes by ${(maxStep * 100).toFixed(2)}% per sample at most`)
})

test('limitPeaks: leaves a signal under the ceiling alone, and keeps left/right balance when it acts', () => {
  const quiet = tone(0.2, 0.3)
  const before = Float32Array.from(quiet.left)
  limitPeaks(quiet.left, quiet.right, 0.9)
  assert.deepEqual(quiet.left, before)

  const left = new Float32Array(2000).fill(1.5)
  const right = new Float32Array(2000).fill(0.75)
  limitPeaks(left, right, 0.9)
  assert.ok(left.every((v) => v <= 0.9 + 1e-6))
  assert.ok(left.every((v, i) => Math.abs(right[i] / v - 0.5) < 1e-5), 'same gain on both channels')
})
