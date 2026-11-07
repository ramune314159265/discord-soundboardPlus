// 音量の正規化: どんな音声でも「聞こえる大きさ」が同じくらいになるように、全体のゲインを決めて掛ける。
//   1. ITU-R BS.1770 の K 特性 + ゲート付きの統合ラウドネス (LUFS) を測る
//   2. 目標のラウドネスになるゲインを掛ける (小さすぎる音は上げ、大きすぎる音は下げる)
//   3. ピークが天井を超える部分は、先読みリミッターで滑らかに抑える (切り捨てて歪ませない)
// 入力は 48kHz のステレオ (Float32Array)。DOM に依存しないので Node でテストできる。

import { SAMPLE_RATE } from './opusEncoders.js'

/** 目標ラウドネス。複数を重ねて鳴らしても溢れにくいよう、放送の基準 (-23) と配信の基準 (-14) の間やや控えめにしている */
export const TARGET_LUFS = -18
/** ピークの天井 (dBFS) */
export const CEILING_DB = -1
/** 小さすぎる音を上げすぎない (ノイズを持ち上げないため) / 大きすぎる音を下げすぎない */
export const MAX_BOOST_DB = 24
export const MAX_CUT_DB = -40

// K 特性フィルタ (48kHz) の係数: ① 高域シェルフ ② ハイパス
const STAGE1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] }
const STAGE2 = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] }

function biquad(input, { b, a }) {
  const out = new Float64Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

/** 区間 [from, to) の二乗平均 */
function meanSquare(samples, prefix, from, to) {
  return (prefix[to] - prefix[from]) / (to - from)
}

function prefixOfSquares(samples) {
  const prefix = new Float64Array(samples.length + 1)
  for (let i = 0; i < samples.length; i++) prefix[i + 1] = prefix[i] + samples[i] * samples[i]
  return prefix
}

const toLufs = (power) => -0.691 + 10 * Math.log10(power)

/**
 * 統合ラウドネス (LUFS)。400ms のブロック (75% 重なり) を、絶対ゲート (-70) と相対ゲート (-10LU) で選んで平均する。
 * 400ms に満たない短い音は、全体を1ブロックとして扱う。無音なら -Infinity。
 * @param {Float32Array} left
 * @param {Float32Array} right
 */
export function measureLoudness(left, right) {
  const n = Math.min(left.length, right.length)
  if (n === 0) return -Infinity
  const weighted = [left, right].map((ch) => biquad(biquad(ch.subarray(0, n), STAGE1), STAGE2))
  const prefixes = weighted.map(prefixOfSquares)

  const block = Math.round(0.4 * SAMPLE_RATE)
  const step = Math.round(0.1 * SAMPLE_RATE)
  const powers = []
  if (n < block) {
    powers.push(prefixes.reduce((sum, p, i) => sum + meanSquare(weighted[i], p, 0, n), 0))
  } else {
    for (let start = 0; start + block <= n; start += step) {
      powers.push(prefixes.reduce((sum, p, i) => sum + meanSquare(weighted[i], p, start, start + block), 0))
    }
  }

  const absolute = powers.filter((p) => p > 0 && toLufs(p) > -70)
  if (absolute.length === 0) return -Infinity
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length
  const relativeThreshold = toLufs(mean(absolute)) - 10
  const gated = absolute.filter((p) => toLufs(p) > relativeThreshold)
  return toLufs(mean(gated.length > 0 ? gated : absolute))
}

/**
 * 先読みリミッター: ピークが天井を超える前から少しずつゲインを下げ、超えたあとも少しずつ戻す。
 * 左右は同じゲインで抑える (定位を崩さない)。結果は必ず天井以下になる。
 * @param {Float32Array} left   (その場で書き換える)
 * @param {Float32Array} right
 * @param {number} ceiling 0〜1
 * @param {number} lookahead 先読みのサンプル数
 */
export function limitPeaks(left, right, ceiling, lookahead = Math.round(0.005 * SAMPLE_RATE)) {
  const n = Math.min(left.length, right.length)
  let over = false
  const need = new Float32Array(n).fill(1)
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]))
    if (peak > ceiling) {
      need[i] = ceiling / peak
      over = true
    }
  }
  if (!over) return

  // 各サンプルの前後 lookahead 個の最小値 (単調なキューで O(n))
  const w = lookahead
  const mins = new Float32Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  let next = 0
  for (let i = 0; i < n; i++) {
    const last = Math.min(n - 1, i + w)
    for (; next <= last; next++) {
      while (tail > head && need[queue[tail - 1]] >= need[next]) tail--
      queue[tail++] = next
    }
    while (queue[head] < i - w) head++
    mins[i] = need[queue[head]]
  }

  // 幅 2w+1 の移動平均でなだらかにする。各サンプルは自分より w 以内の最小値以下の平均になるので、天井を超えない
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + mins[i]
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - w)
    const to = Math.min(n, i + w + 1)
    const gain = (prefix[to] - prefix[from]) / (to - from)
    left[i] *= gain
    right[i] *= gain
  }
}

/**
 * 目標のラウドネスに揃える。元の配列は書き換えず、新しい配列を返す。
 * @param {{ left: Float32Array, right: Float32Array }} pcm
 * @param {{ targetLufs?: number, ceilingDb?: number }} [options]
 * @returns {{ left: Float32Array, right: Float32Array, measuredLufs: number, gainDb: number }}
 */
export function normalizeLoudness({ left, right }, { targetLufs = TARGET_LUFS, ceilingDb = CEILING_DB } = {}) {
  const measuredLufs = measureLoudness(left, right)
  if (!Number.isFinite(measuredLufs)) {
    // 無音 (または聞こえないほど小さい) は、そのまま
    return { left, right, measuredLufs, gainDb: 0 }
  }
  const gainDb = Math.min(MAX_BOOST_DB, Math.max(MAX_CUT_DB, targetLufs - measuredLufs))
  const gain = 10 ** (gainDb / 20)
  const outLeft = new Float32Array(left.length)
  const outRight = new Float32Array(right.length)
  for (let i = 0; i < left.length; i++) outLeft[i] = left[i] * gain
  for (let i = 0; i < right.length; i++) outRight[i] = right[i] * gain
  limitPeaks(outLeft, outRight, 10 ** (ceilingDb / 20))
  return { left: outLeft, right: outRight, measuredLufs, gainDb }
}
