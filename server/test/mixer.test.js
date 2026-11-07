import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FRAME_BYTES, LookaheadLimiter, Mixer } from '../src/mixer.js'
import { FRAME_SAMPLES, OggOpusSource, parseOggOpus } from '../src/oggOpusSource.js'

const beepPath = fileURLToPath(new URL('./fixtures/beep.ogg', import.meta.url))
const beep = () => fs.readFileSync(beepPath)
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/** 一定値を n フレーム返す音源 */
function constantSource(value, frames) {
  let left = frames
  return {
    closed: false,
    readFrame() {
      if (left-- <= 0) return null
      return new Int16Array(FRAME_SAMPLES).fill(value)
    },
    close() {
      this.closed = true
    },
  }
}

/** pacing 無しのミキサーから n フレーム (Int16Array) を直接作る */
function frames(mixer, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const buf = mixer.nextFrame()
    out.push(buf && new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2))
  }
  return out
}

/** ffmpeg で同じ Ogg を s16le に展開した結果 (基準) */
function ffmpegDecode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 's16le', '-ar', '48000', '-ac', '2', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(r.status, 0, r.stderr?.toString())
  return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 2)
}

function readAll(source) {
  const parts = []
  for (let f = source.readFrame(); f; f = source.readFrame()) parts.push(f)
  const all = new Int16Array(parts.length * FRAME_SAMPLES)
  parts.forEach((p, i) => all.set(p, i * FRAME_SAMPLES))
  return all
}

// ---------------------------------------------------------------- Ogg Opus の展開

test('parseOggOpus: splits the file into the audio packets and reads pre-skip / length', () => {
  const { packets, preSkip, totalSamples } = parseOggOpus(beep())
  assert.ok(packets.length > 10)
  assert.ok(preSkip > 0)
  assert.ok(Math.abs(totalSamples / 48000 - 0.6) < 0.03, `length ${totalSamples / 48000}s`)
})

test('parseOggOpus: rejects data that is not Ogg Opus', () => {
  assert.throws(() => parseOggOpus(Buffer.alloc(200, 1)))
  assert.throws(() => new OggOpusSource(beep().subarray(0, 40)))
})

test('OggOpusSource: decodes to the same PCM as ffmpeg (same length, same samples)', { skip: !hasFfmpeg }, () => {
  const mine = readAll(new OggOpusSource(beep()))
  const reference = ffmpegDecode(beepPath)
  // 最後のフレームは無音で埋めてあるので、基準の長さ以降は 0
  assert.ok(mine.length >= reference.length && mine.length - reference.length < FRAME_SAMPLES, `${mine.length} vs ${reference.length}`)
  let maxDiff = 0
  for (let i = 0; i < reference.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - reference[i]))
  assert.ok(maxDiff <= 2, `max sample difference ${maxDiff}`)
  assert.ok(mine.subarray(reference.length).every((v) => v === 0))
  assert.ok(reference.some((v) => Math.abs(v) > 1000), 'the fixture is audible')
})

test('OggOpusSource: close frees the decoder, and is safe to call twice', () => {
  let deleted = 0
  const source = new OggOpusSource(beep(), {
    createDecoder: () => ({ decode: () => Buffer.alloc(960 * 4), delete: () => deleted++ }),
  })
  assert.ok(source.readFrame())
  source.close()
  source.close()
  assert.equal(deleted, 1)
  assert.equal(source.readFrame(), null)
})

// ---------------------------------------------------------------- 合成

// 出力は、リミッターの先読みのため 1 フレーム (20ms) 遅れる: out[0] は無音、out[k] は k-1 番目に合成したフレーム。
// 各音の最初の約 2ms (96 サンプル) はクリック防止のフェードインが掛かる。
const FADE = 96

test('mix: a single sound passes through unchanged (after the 20ms delay and the 2ms fade-in)', () => {
  const mixer = new Mixer({ pacing: false })
  mixer.add(constantSource(30_000, 2))
  const [delay, a, b, c] = frames(mixer, 4)
  assert.ok(delay.every((v) => v === 0), 'the first frame is the lookahead delay')
  assert.ok(a[0] === 0 && a[FADE * 2 - 2] > 0 && a[FADE * 2 - 2] < 30_000, 'fades in from silence')
  assert.ok(a.subarray(FADE * 2).every((v) => v === 30_000), 'then exactly the original')
  assert.ok(b.every((v) => v === 30_000))
  assert.ok(c.every((v) => v === 0), 'silence after it ended')
})

test('mix: two sounds are added sample by sample', () => {
  const mixer = new Mixer({ pacing: false })
  mixer.add(constantSource(1000, 3))
  mixer.add(constantSource(-300, 1))
  const [, a, b] = frames(mixer, 3)
  assert.ok(a.subarray(FADE * 2).every((v) => v === 700))
  assert.ok(b.every((v) => v === 1000), 'the shorter one just drops out')
})

test('limiter: a sum far beyond full scale never clips or wraps around; the gain comes down before the loud part', () => {
  const mixer = new Mixer({ pacing: false, maxVoices: 8 })
  for (let i = 0; i < 4; i++) mixer.add(constantSource(30_000, 3)) // 合計 120000 (約 3.7 倍)
  const [delay, a, b, c] = frames(mixer, 4)
  assert.ok(delay.every((v) => v === 0))
  for (const frame of [a, b, c]) {
    assert.ok(frame.every((v) => v >= 0 && v <= 32_767), 'no wrap-around, no overflow')
  }
  // 抑え込んだあとの定常: 合計 120000 を 32767 以下に収める (約 0.27 倍)
  assert.ok(b.every((v) => v > 20_000 && v <= 32_767), `steady level ${b[100]}`)
})

test('limiter: below full scale it does nothing at all (gain stays exactly 1)', () => {
  const limiter = new LookaheadLimiter()
  const raw = new Float64Array(1920).fill(20_000)
  limiter.process(raw)
  const out = limiter.process(raw)
  assert.ok(out.every((v) => v === 20_000))
  assert.equal(limiter.gain, 1)
})

test('limiter: the output never exceeds the ceiling, however abrupt the onset, and gain changes are smooth', () => {
  const limiter = new LookaheadLimiter({ ceiling: 30_000 })
  const quiet = new Float64Array(1920).fill(1000)
  const loud = new Float64Array(1920)
  for (let i = 0; i < 1920; i++) loud[i] = i < 1000 ? 1000 : 90_000 * Math.sin(i / 7) // 途中から突然大きくなる
  const outputs = []
  for (const raw of [quiet, quiet, loud, loud, quiet, quiet, quiet, quiet]) outputs.push(limiter.process(raw))
  for (const out of outputs) assert.ok(out.every((v) => Math.abs(v) <= 30_000))
  // 小さい音のところのゲインの変わり方: 隣のサンプルとの比が急に変わらない
  const steady = outputs[1]
  assert.ok(steady.every((v) => v === 1000), 'a quiet passage before the loud one is untouched')
  // 大きい音が過ぎたあとは、1 に向けてゆっくり戻る (一気には戻らない)
  const afterLoud = outputs.slice(4).map((o) => o[0])
  assert.ok(afterLoud.every((v, i) => i === 0 || v >= afterLoud[i - 1]), 'release is monotonic')
  assert.ok(afterLoud[1] < 1000, 'not back to full level immediately')
})

test('limiter: attack is spread over the whole frame, so even the first loud sample is already attenuated', () => {
  const limiter = new LookaheadLimiter()
  const loud = new Float64Array(1920).fill(100_000)
  limiter.process(new Float64Array(1920)) // 先頭の遅延フレーム
  limiter.process(loud)
  assert.ok(limiter.gain < 0.33, `gain ${limiter.gain}`)
  const out = limiter.process(loud)
  assert.ok(out.every((v) => v <= 32_767))
})

// ---------------------------------------------------------------- 音の管理

test('add: respects the simultaneous limit, ids are unique, and list() reports the extra info', () => {
  const mixer = new Mixer({ pacing: false, maxVoices: 2 })
  const a = mixer.add(constantSource(1, 5), { soundId: 'a' })
  const b = mixer.add(constantSource(1, 5), { soundId: 'a' })
  assert.notEqual(a, b)
  assert.equal(mixer.isFull, true)
  assert.equal(mixer.add(constantSource(1, 5), { soundId: 'c' }), null)
  assert.deepEqual(mixer.list().map(({ soundId }) => soundId), ['a', 'a'])
})

test('voices that finish are removed (and closed), and a change event is emitted', () => {
  const mixer = new Mixer({ pacing: false })
  const changes = []
  mixer.on('change', (list) => changes.push(list.length))
  const short = constantSource(1, 1)
  mixer.add(short, { soundId: 's' })
  mixer.add(constantSource(1, 3), { soundId: 'l' })
  frames(mixer, 4)
  assert.equal(short.closed, true)
  assert.deepEqual(changes, [1, 2, 1, 0])
})

test('stop / stopAll: remove voices, close them, and report the change', () => {
  const mixer = new Mixer({ pacing: false })
  const s1 = constantSource(1, 99)
  const s2 = constantSource(1, 99)
  const id1 = mixer.add(s1)
  mixer.add(s2)
  assert.equal(mixer.stop(id1), true)
  assert.equal(mixer.stop(id1), false)
  assert.equal(mixer.size, 1, 'it disappears from the list right away')
  mixer.nextFrame() // フェードアウトする次の20msで、音源が閉じられる
  assert.equal(s1.closed, true)
  mixer.stopAll()
  assert.equal(mixer.size, 0)
  mixer.nextFrame()
  assert.equal(s2.closed, true)
})

test('a source that throws is dropped on its own; the others keep playing', () => {
  const mixer = new Mixer({ pacing: false })
  const errors = []
  mixer.on('voiceError', (id, err) => errors.push([id, err.message]))
  const bad = {
    readFrame() {
      throw new Error('decode failed')
    },
    close() {
      this.closed = true
    },
  }
  const badId = mixer.add(bad, { soundId: 'bad' })
  mixer.add(constantSource(500, 2), { soundId: 'ok' })
  const [, a, b] = frames(mixer, 3)
  assert.ok(a.subarray(FADE * 2).every((v) => v === 500) && b.every((v) => v === 500))
  assert.deepEqual(errors, [[badId, 'decode failed']])
  assert.equal(bad.closed, true)
})

// ---------------------------------------------------------------- 出力ストリーム

test('stream: a new output stream is announced only when there is none running', () => {
  const mixer = new Mixer({ pacing: false })
  const streams = []
  mixer.on('stream', (s) => streams.push(s))
  mixer.add(constantSource(1, 50))
  mixer.add(constantSource(1, 50))
  assert.equal(streams.length, 1)
})

test('stream: ends after the sounds are gone plus a short silent grace, then the next sound gets a new stream', async () => {
  const mixer = new Mixer({ pacing: false })
  const streams = []
  mixer.on('stream', (s) => streams.push(s))
  mixer.add(constantSource(1, 2))

  // for await は溜まっている分をまとめて渡すので、バイト数でフレーム数を数える
  let bytes = 0
  for await (const chunk of streams[0]) bytes += chunk.length
  assert.equal(bytes % FRAME_BYTES, 0)
  const silent = bytes / FRAME_BYTES - 2
  assert.ok(silent >= 5 && silent <= 16, `grace frames ${silent}`)

  mixer.add(constantSource(1, 2))
  assert.equal(streams.length, 2)
})

test('stream: a sound added during the silent grace joins the running stream', async () => {
  const mixer = new Mixer({ pacing: false })
  const streams = []
  mixer.on('stream', (s) => streams.push(s))
  mixer.add(constantSource(1, 1))
  streams[0].read(FRAME_BYTES)
  streams[0].read(FRAME_BYTES)
  mixer.add(constantSource(7, 2))
  assert.equal(streams.length, 1)
})

test('stream: destroying it from outside (the player stopped) stops the sounds that were playing', async () => {
  const mixer = new Mixer({ pacing: false })
  const streams = []
  mixer.on('stream', (s) => streams.push(s))
  const source = constantSource(1, 99)
  mixer.add(source)
  streams[0].destroy()
  await new Promise((resolve) => streams[0].once('close', resolve))
  assert.equal(mixer.size, 0)
  assert.equal(source.closed, true)
  // その後に足した音は、新しいストリームで鳴らす
  mixer.add(constantSource(1, 3))
  assert.equal(streams.length, 2)
})

test('stream: with pacing, frames come out in real time (not as fast as possible)', async () => {
  const mixer = new Mixer({ maxVoices: 8 })
  const streams = []
  mixer.on('stream', (s) => streams.push(s))
  mixer.add(constantSource(1, 100))

  const started = Date.now()
  let n = 0
  for await (const _chunk of streams[0]) {
    if (++n === 12) break
  }
  const elapsed = Date.now() - started
  // 12フレーム = 240ms。先行して作る分 (2フレーム) を差し引いても 160ms 以上かかる
  assert.ok(elapsed >= 150, `too fast: ${elapsed}ms`)
  assert.ok(elapsed < 600, `too slow: ${elapsed}ms`)
  mixer.close()
})

test('close: stops every sound and closes the stream', async () => {
  const mixer = new Mixer({ pacing: false })
  const streams = []
  mixer.on('stream', (s) => streams.push(s))
  const source = constantSource(1, 99)
  mixer.add(source)
  mixer.close()
  assert.equal(source.closed, true)
  assert.equal(streams[0].destroyed, true)
})

// ---------------------------------------------------------------- 実際の音声を重ねる

test('two copies of a real sound, offset in time, mix to the sum of the two decodes', { skip: !hasFfmpeg }, () => {
  const reference = ffmpegDecode(beepPath)
  const mixer = new Mixer({ pacing: false })
  mixer.add(new OggOpusSource(beep()))
  const offsetFrames = 5
  const first = frames(mixer, offsetFrames)
  mixer.add(new OggOpusSource(beep()))
  const rest = frames(mixer, Math.ceil(reference.length / FRAME_SAMPLES) + 2)

  // out[0] は先読みの遅延フレーム。それを除くと、出力の位置 = 合成したフレームの位置
  const outFrames = [...first, ...rest].slice(1)
  const mixed = new Int16Array(outFrames.length * FRAME_SAMPLES)
  outFrames.forEach((f, i) => mixed.set(f, i * FRAME_SAMPLES))

  const offset = offsetFrames * FRAME_SAMPLES
  let maxErr = 0
  for (let i = 0; i < mixed.length; i++) {
    if (i < FADE * 2 || (i >= offset && i < offset + FADE * 2)) continue // 各音の出だしのフェードイン
    const a = i < reference.length ? reference[i] : 0
    const b = i >= offset && i - offset < reference.length ? reference[i - offset] : 0
    const sum = a + b
    if (Math.abs(sum) < 32_000) maxErr = Math.max(maxErr, Math.abs(mixed[i] - sum))
  }
  assert.ok(maxErr <= 4, `max error ${maxErr}`)
})
