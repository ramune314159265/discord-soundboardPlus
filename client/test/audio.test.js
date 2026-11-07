import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OggOpusMuxer, oggCrc32 } from '../src/audio/oggMuxer.js'
import { encodePcmToOgg } from '../src/audio/encode.js'

/** 生成した Ogg を自前でパースして構造を確認する */
function parsePages(bytes) {
  const pages = []
  let off = 0
  while (off < bytes.length) {
    assert.equal(String.fromCharCode(...bytes.subarray(off, off + 4)), 'OggS', `capture pattern at ${off}`)
    const view = new DataView(bytes.buffer, bytes.byteOffset + off)
    const segCount = bytes[off + 26]
    const lacing = Array.from(bytes.subarray(off + 27, off + 27 + segCount))
    const bodyLength = lacing.reduce((a, b) => a + b, 0)
    const end = off + 27 + segCount + bodyLength
    const page = bytes.slice(off, end)
    const stored = new DataView(page.buffer).getUint32(22, true)
    new DataView(page.buffer).setUint32(22, 0, true)
    assert.equal(oggCrc32(page), stored, `crc of page ${pages.length}`)
    pages.push({
      flags: bytes[off + 5],
      granule: view.getUint32(6, true) + view.getUint32(10, true) * 2 ** 32,
      sequence: view.getUint32(18, true),
      segCount,
      lacing,
      bodyLength,
    })
    off = end
  }
  return pages
}

const sine = (samples, freq = 440) => {
  const left = new Float32Array(samples)
  const right = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    left[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / 48000)
    right[i] = 0.4 * Math.sin((2 * Math.PI * freq * 1.5 * i) / 48000)
  }
  return { left, right }
}

test('muxer: header pages, lacing for 255-multiples, sequence numbers and EOS', () => {
  const mux = new OggOpusMuxer({ serial: 1234 })
  mux.addPacket(new Uint8Array(255).fill(1), 960) // ちょうど255 → 終端0セグメントが必要
  mux.addPacket(new Uint8Array(10).fill(2), 960)
  mux.addPacket(new Uint8Array(600).fill(3), 960) // 255+255+90
  const bytes = mux.finish()
  const pages = parsePages(bytes)

  assert.equal(pages.length, 3)
  assert.equal(pages[0].flags, 0x02) // BOS (OpusHead)
  assert.equal(pages[0].granule, 0)
  assert.equal(pages[1].granule, 0) // OpusTags
  assert.equal(pages[2].flags, 0x04) // EOS
  assert.equal(pages[2].granule, 960 * 3)
  assert.deepEqual(pages.map((p) => p.sequence), [0, 1, 2])
  assert.deepEqual(pages[2].lacing, [255, 0, 10, 255, 255, 90])
  assert.equal(String.fromCharCode(...bytes.subarray(28, 36)), 'OpusHead')
})

test('muxer: splits pages by packet count and trims final granule to the real length', () => {
  const mux = new OggOpusMuxer({ preSkip: 312 })
  for (let i = 0; i < 120; i++) mux.addPacket(new Uint8Array(40), 960)
  const pages = parsePages(mux.finish(120 * 960 - 500))
  assert.equal(pages.length, 2 + 3) // 50 + 50 + 20 パケット
  assert.equal(pages[2].granule, 50 * 960)
  assert.equal(pages[3].granule, 100 * 960)
  assert.equal(pages[4].granule, 312 + 120 * 960 - 500)
})

test('muxer: too many segments are split across pages', () => {
  const mux = new OggOpusMuxer()
  for (let i = 0; i < 4; i++) mux.addPacket(new Uint8Array(255 * 70), 960) // 1パケット71セグメント
  const pages = parsePages(mux.finish())
  assert.ok(pages.every((p) => p.segCount <= 255))
  assert.equal(pages.length, 2 + 2) // 3パケット(213) + 1パケット(71)
})

test('opusscript fallback encodes valid Ogg Opus', async () => {
  const { left, right } = sine(48000 * 1 + 123) // 1秒+端数
  const result = await encodePcmToOgg({ left, right, encoders: ['opusscript'] })
  assert.equal(result.encoder, 'opusscript')
  assert.ok(Math.abs(result.durationMs - 1003) <= 2)
  const pages = parsePages(result.data)
  assert.equal(pages[0].flags, 0x02)
  assert.equal(pages.at(-1).flags, 0x04)
  assert.equal(pages.at(-1).granule, 312 + left.length)
  assert.ok(result.data.length > 1000 && result.data.length < 40000, `size ${result.data.length}`)
})

test('encoder falls through when WebCodecs is unavailable (Node)', async () => {
  const { left, right } = sine(9600)
  const result = await encodePcmToOgg({ left, right }) // 既定: webcodecs → opusscript
  assert.equal(result.encoder, 'opusscript')
})

test('abort signal cancels encoding', async () => {
  const { left, right } = sine(48000 * 3)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(encodePcmToOgg({ left, right, encoders: ['opusscript'], signal: controller.signal }), {
    name: 'AbortError',
  })
})

// ---- ffmpeg があれば、実際にデコードして音の中身 (左右の周波数) まで確認する ----
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

function dominantFrequency(samples, from, count) {
  let best = [0, 0]
  for (let freq = 100; freq < 4000; freq += 2) {
    const w = (2 * Math.PI * freq) / 48000
    const coeff = 2 * Math.cos(w)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < count; i++) {
      const s = samples(from + i) + coeff * s1 - s2
      s2 = s1
      s1 = s
    }
    const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / count
    if (power > best[1]) best = [freq, power]
  }
  return best
}

test('decoded audio keeps the right tones in the right channels (ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const total = 48000 * 2 + 321
  const { left, right } = sine(total, 440) // 左 440Hz / 右 660Hz
  const { data } = await encodePcmToOgg({ left, right, encoders: ['opusscript'] })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-enc-'))
  const file = path.join(dir, 'out.ogg')
  fs.writeFileSync(file, data)
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(decoded.status, 0, decoded.stderr?.toString())
  const pcm = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength / 4)
  assert.equal(pcm.length / 2, total, 'decoded length matches the source exactly')

  const [lFreq, lPower] = dominantFrequency((i) => pcm[i * 2], 24000, 48000)
  const [rFreq, rPower] = dominantFrequency((i) => pcm[i * 2 + 1], 24000, 48000)
  assert.ok(Math.abs(lFreq - 440) <= 4, `left tone ${lFreq}Hz`)
  assert.ok(Math.abs(rFreq - 660) <= 4, `right tone ${rFreq}Hz`)
  assert.ok(lPower > 1500 && rPower > 1500, // 振幅0.4 → 理論値 0.4^2*48000/4 = 1920
     `tone power L=${lPower.toFixed(0)} R=${rPower.toFixed(0)}`)
})
