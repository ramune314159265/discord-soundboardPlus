import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { inspectOgg } from '../src/ogg.js'

const fixture = () => fs.readFileSync(new URL('./fixtures/beep.ogg', import.meta.url))

test('valid Ogg Opus is accepted and duration is computed', () => {
  const info = inspectOgg(fixture())
  assert.equal(info.ok, true)
  assert.equal(info.channels, 2)
  assert.ok(Math.abs(info.durationMs - 600) <= 30, `duration ${info.durationMs}`)
})

test('corrupted bytes are rejected by CRC', () => {
  const buf = Buffer.from(fixture())
  buf[100] ^= 0xff
  assert.deepEqual(inspectOgg(buf), { ok: false, error: 'bad_crc' })
})

test('truncated file is rejected', () => {
  const buf = fixture().subarray(0, 200)
  assert.equal(inspectOgg(buf).ok, false)
})

test('non-Ogg data is rejected', () => {
  const info = inspectOgg(Buffer.alloc(256, 7))
  assert.equal(info.ok, false)
})
