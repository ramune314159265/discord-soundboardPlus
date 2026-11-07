import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from 'jotai'
import { pickTarget, startWeb } from '../src/webBootstrap.js'
import * as S from '../src/state.js'

const t = (g, c, botHere = true) => ({ guildId: g, channelId: c, name: g, channelName: c, iconUrl: null, botHere })

test('pickTarget: keeps the current call, auto-picks a single one, asks when several', () => {
  assert.equal(pickTarget([], null), null)
  const a = t('1', 'a')
  const b = t('2', 'b')
  assert.equal(pickTarget([a], null), a)
  assert.equal(pickTarget([a, b], null), null)
  assert.equal(pickTarget([a, b], b), b)
  assert.equal(pickTarget([a, b], t('9', 'z')), null, 'current call is gone')
  assert.equal(pickTarget([a, b], null, t('2', 'b')), b)
  assert.equal(pickTarget([a], null, t('2', 'b')), null, 'chosen call is gone')
})

function harness({ session, steps, joins = [] }) {
  const store = createStore()
  const log = []
  let i = 0
  const run = startWeb(store, {
    poll: 5,
    fetchSession: async () => session,
    fetchTargets: async () => {
      const step = steps[Math.min(i++, steps.length - 1)]
      if (step instanceof Error) throw step
      return { targets: step }
    },
    createApi: ({ guildId }) => ({ joinBot: async (channelId, opts) => joins.push([guildId, channelId, opts]) }),
    connect: (_store, opts) => {
      log.push(['connect', opts.guildId, opts.channelId, opts.web])
      setTimeout(() => opts.onFirstReady(), 0)
      return () => log.push(['stop', opts.guildId])
    },
  })
  return { store, log, run }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const status = (store) => store.get(S.appStatusAtom).status

test('web start: not logged in shows the login screen and never connects', async () => {
  const { store, log, run } = harness({ session: null, steps: [[]] })
  await run
  assert.equal(status(store), 'login')
  assert.deepEqual(log, [])
})

test('web start: waits until in the bot call, connects, and drops back when the user leaves the call', async () => {
  const a = t('1', 'a')
  const { store, log, run } = harness({ session: { access_token: 'tok', user: { id: '5', username: 'u' } }, steps: [[], [a], [a], []] })
  await run
  assert.equal(status(store), 'waiting')

  await wait(40)
  assert.deepEqual(log[0], ['connect', '1', 'a', true], 'connects as a web client once in the call')
  assert.equal(store.get(S.sessionAtom), null, 'session cleared after leaving the call')
  assert.ok(log.some(([k]) => k === 'stop'), 'socket stopped when the call is gone')
  assert.equal(status(store), 'waiting')
  assert.equal(log.filter(([k]) => k === 'connect').length, 1, 'no reconnect while the call stays the same')
  ;(await run).stop()
})

test('web start: several calls ask the user to choose; a transient error is retried', async () => {
  const a = t('1', 'a')
  const b = t('2', 'b')
  const { store, log, run } = harness({ session: { access_token: 'tok', user: { id: '5', username: 'u' } }, steps: [new Error('boom'), [a, b]] })
  await run
  await wait(30)
  assert.equal(status(store), 'choose')
  assert.deepEqual(log, [])
  store.get(S.webControlsAtom).choose(b)
  await wait(30)
  assert.deepEqual(log.find(([k]) => k === 'connect'), ['connect', '2', 'b', true])
  ;(await run).stop()
})

test('web start: a call without the bot offers "call the bot", and connects once it joins', async () => {
  const lonely = t('1', 'a', false)
  const joined = t('1', 'a', true)
  const joins = []
  const { store, log, run } = harness({ session: { access_token: 'tok', user: { id: '5', username: 'u' } }, steps: [[lonely], [lonely], [joined]], joins })
  await run
  assert.equal(status(store), 'waiting')
  assert.deepEqual(store.get(S.webCallableAtom), [lonely])
  assert.deepEqual(log, [], 'does not connect while the bot is not there')

  await store.get(S.webControlsAtom).callBot(lonely)
  assert.deepEqual(joins, [['1', 'a', { web: true }]])
  await wait(30)
  assert.deepEqual(log.find(([k]) => k === 'connect'), ['connect', '1', 'a', true])
  assert.deepEqual(store.get(S.webCallableAtom), [])
  ;(await run).stop()
})
