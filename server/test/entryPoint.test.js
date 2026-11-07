import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureEntryPoint } from '../src/entryPoint.js'

/** 呼び出しを記録するモック fetch。commands はアプリの既存コマンド一覧 */
function mockDiscord(commands, { failWith } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, url: new URL(url).pathname, body, auth: init.headers.Authorization })
    if (failWith) return new Response('nope', { status: failWith })
    if (init.method === 'GET') return Response.json(commands)
    if (init.method === 'POST') return Response.json({ id: 'new1', ...body })
    return Response.json({ ...commands.find((c) => url.endsWith(c.id)), ...body })
  }
  return { fetchImpl, calls }
}

const opts = { applicationId: '123', botToken: 'tok' }

test('creates the entry point command when missing (other commands are ignored)', async () => {
  const { fetchImpl, calls } = mockDiscord([{ id: 'c1', type: 1, name: 'ping' }])
  const result = await ensureEntryPoint({ ...opts, fetchImpl })
  assert.equal(result.action, 'created')
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST'])
  assert.equal(calls[1].url, '/api/v10/applications/123/commands')
  assert.equal(calls[1].auth, 'Bot tok')
  assert.deepEqual(calls[1].body, {
    name: 'launch',
    description: 'サウンドボードを起動します',
    type: 4, // PRIMARY_ENTRY_POINT
    handler: 2, // DISCORD_LAUNCH_ACTIVITY
  })
})

test('does nothing when the Discord-handled entry point already exists', async () => {
  const { fetchImpl, calls } = mockDiscord([{ id: 'c9', type: 4, name: 'launch', handler: 2 }])
  const result = await ensureEntryPoint({ ...opts, fetchImpl })
  assert.equal(result.action, 'unchanged')
  assert.deepEqual(calls.map((c) => c.method), ['GET'])
})

test('patches the handler when the existing entry point is app-handled', async () => {
  const { fetchImpl, calls } = mockDiscord([{ id: 'c9', type: 4, name: 'launch', handler: 1 }])
  const result = await ensureEntryPoint({ ...opts, fetchImpl })
  assert.equal(result.action, 'updated')
  assert.equal(calls[1].method, 'PATCH')
  assert.equal(calls[1].url, '/api/v10/applications/123/commands/c9')
  assert.deepEqual(calls[1].body, { handler: 2 })
})

test('surfaces API errors with a hint', async () => {
  const { fetchImpl } = mockDiscord([], { failWith: 401 })
  await assert.rejects(ensureEntryPoint({ ...opts, fetchImpl }), /401.*トークン/)
})

test('requires credentials', async () => {
  await assert.rejects(ensureEntryPoint({ applicationId: '', botToken: '' }), /必要/)
})
