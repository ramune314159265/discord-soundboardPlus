import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SoundStore, isGuildId, isSoundId } from '../src/store.js'

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-store-'))
  return { dir, store: new SoundStore(dir) }
}

const input = (name, extra = {}) => ({
  guildId: '111',
  name,
  emoji: '🔊',
  data: Buffer.from('OggS-fake-' + name),
  durationMs: 500,
  createdBy: '42',
  ...extra,
})

test('flat layout: add / get / list / remove and persistence across instances', async () => {
  const { dir, store } = await tmpStore()
  const a = await store.add(input('a'))
  const b = await store.add(input('b', { tags: ['x'] }))
  assert.deepEqual((await store.listByGuild('111')).map((s) => s.name), ['a', 'b'])
  assert.deepEqual(b.tags, ['x'])
  assert.deepEqual(a.tags, [])
  assert.equal(await fs.readFile(store.filePath(a.id), 'utf8'), 'OggS-fake-a')

  // サーバーごとのフォルダは作らず、sounds/ にフラットに置く
  assert.deepEqual((await fs.readdir(dir)).sort(), ['sounds'])
  assert.deepEqual((await fs.readdir(path.join(dir, 'sounds'))).sort(), ['index.json', `${a.id}.ogg`, `${b.id}.ogg`].sort())

  // 別インスタンス(=再起動)でも読める
  const again = new SoundStore(dir)
  assert.equal((await again.listByGuild('111')).length, 2)
  assert.equal((await again.get(b.id)).name, 'b')

  assert.equal(await store.remove(a.id), true)
  assert.equal(await store.remove(a.id), false)
  assert.deepEqual((await store.listByGuild('111')).map((s) => s.id), [b.id])
  await assert.rejects(fs.stat(store.filePath(a.id)))
})

test('listByGuild and listByOwner filter the same flat list', async () => {
  const { store } = await tmpStore()
  const x = await store.add(input('x', { guildId: '111', createdBy: '1' }))
  const y = await store.add(input('y', { guildId: '222', createdBy: '1' }))
  const z = await store.add(input('z', { guildId: '222', createdBy: '2' }))
  assert.deepEqual((await store.listByGuild('222')).map((s) => s.id), [y.id, z.id])
  assert.deepEqual((await store.listByOwner('1')).map((s) => s.id), [x.id, y.id])
  assert.deepEqual(await store.listByOwner('9'), [])
})

test('update changes only the given fields and persists', async () => {
  const { dir, store } = await tmpStore()
  const a = await store.add(input('a', { tags: ['t1'] }))
  const u = await store.update(a.id, { name: 'A2', tags: ['t2', 't3'] })
  assert.deepEqual([u.name, u.emoji, u.tags], ['A2', '🔊', ['t2', 't3']])
  assert.ok(u.updatedAt >= a.updatedAt)
  const reread = await new SoundStore(dir).get(a.id)
  assert.deepEqual([reread.name, reread.tags], ['A2', ['t2', 't3']])
  assert.equal(await store.update('00000000-0000-4000-8000-000000000000', { name: 'n' }), null)

  // 返した値を書き換えても内部には影響しない
  u.tags.push('hack')
  assert.deepEqual((await store.get(a.id)).tags, ['t2', 't3'])
})

test('concurrent adds are serialized and all persisted', async () => {
  const { dir, store } = await tmpStore()
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(input(`s${i}`))))
  const json = JSON.parse(await fs.readFile(path.join(dir, 'sounds/index.json'), 'utf8'))
  assert.equal(json.sounds.length, 20)
  const files = (await fs.readdir(path.join(dir, 'sounds'))).filter((n) => n.endsWith('.ogg'))
  assert.equal(files.length, 20)
})

test('broken index.json is set aside, not fatal', async () => {
  const { dir, store } = await tmpStore()
  await fs.mkdir(path.join(dir, 'sounds'), { recursive: true })
  await fs.writeFile(path.join(dir, 'sounds/index.json'), '{ not json')
  assert.deepEqual(await store.listByGuild('111'), [])
  const names = await fs.readdir(path.join(dir, 'sounds'))
  assert.ok(names.some((n) => n.startsWith('index.json.broken-')))
})

test('ids are validated against path traversal', async () => {
  const { store } = await tmpStore()
  assert.equal(isGuildId('../etc'), false)
  assert.equal(isGuildId('123456789012345678'), true)
  assert.equal(isSoundId('../../x'), false)
  assert.throws(() => store.filePath('../../x'))
  await assert.rejects(async () => store.add(input('x', { guildId: '../x' })))
})
