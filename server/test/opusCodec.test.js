import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OpusCodec } from '../src/opusCodec.js'
import { parseOggOpus } from '../src/oggOpusSource.js'

const beepPath = fileURLToPath(new URL('./fixtures/beep.ogg', import.meta.url))
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const { packets, preSkip } = parseOggOpus(fs.readFileSync(beepPath))

test('decode matches ffmpeg even with several decoders alive and interleaved (regression: opusscript wrapper corrupted its neighbours)', { skip: !hasFfmpeg }, () => {
  const reference = spawnSync('ffmpeg', ['-v', 'error', '-i', beepPath, '-f', 's16le', '-ar', '48000', '-ac', '2', '-'], {
    maxBuffer: 1 << 26,
  }).stdout
  const decoders = Array.from({ length: 6 }, () => new OpusCodec())
  const outputs = decoders.map(() => [])
  for (const packet of packets) decoders.forEach((d, i) => outputs[i].push(d.decode(packet)))
  decoders.forEach((d, i) => {
    const pcm = Buffer.concat(outputs[i]).subarray(preSkip * 4)
    let max = 0
    for (let j = 0; j + 2 <= Math.min(pcm.length, reference.length); j += 2) {
      max = Math.max(max, Math.abs(pcm.readInt16LE(j) - reference.readInt16LE(j)))
    }
    assert.ok(max <= 2, `decoder ${i}: max difference ${max}`)
    d.delete()
  })
})

test('encode → decode keeps a tone (and alive codecs do not disturb each other)', () => {
  const encoder = new OpusCodec({ bitrate: 96_000 })
  const decoder = new OpusCodec()
  const noise = new OpusCodec() // 別のインスタンスが間で使われても影響しない
  const frame = Buffer.alloc(960 * 4)
  let t = 0
  let sum = 0
  for (let f = 0; f < 50; f++) {
    for (let i = 0; i < 960; i++, t++) {
      const v = Math.round(12_000 * Math.sin((2 * Math.PI * 440 * t) / 48_000))
      frame.writeInt16LE(v, i * 4)
      frame.writeInt16LE(v, i * 4 + 2)
    }
    const packet = encoder.encode(frame, 960)
    noise.decode(packets[f % packets.length])
    const pcm = decoder.decode(packet)
    assert.equal(pcm.length, 960 * 4)
    if (f > 5) for (let i = 0; i < pcm.length; i += 4) sum += Math.abs(pcm.readInt16LE(i))
  }
  const mean = sum / (44 * 960)
  assert.ok(mean > 7_000 && mean < 8_300, `mean amplitude ${mean} (expected about 7640)`)
  for (const c of [encoder, decoder, noise]) c.delete()
})

test('delete is idempotent, and a deleted codec refuses to run; bad packets throw instead of crashing', () => {
  const codec = new OpusCodec()
  assert.throws(() => codec.decode(Buffer.alloc(10_000)), /大きすぎ/)
  codec.delete()
  codec.delete()
  assert.throws(() => codec.decode(packets[0]), /解放済み/)
})
