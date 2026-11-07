import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { serve } from '@hono/node-server'
import { WebSocket } from 'ws'
import { createAuth } from '../src/auth.js'
import { Hub } from '../src/hub.js'
import { SoundStore } from '../src/store.js'
import { createApp } from '../src/routes.js'
import { attachWebSocket } from '../src/ws.js'
import { BotError } from '../src/bot.js'

const GUILD = '1000000000000000001'
const OTHER_GUILD = '1000000000000000002'
const VC = '2000000000000000001'
const OTHER_VC = '2000000000000000002'
const beep = fs.readFileSync(new URL('./fixtures/beep.ogg', import.meta.url))

// Discord API のモック: トークン → ユーザー/所属ギルド
const USERS = {
  'token-alice': { id: '11', username: 'alice', guilds: [GUILD] },
  'token-bob': { id: '22', username: 'bob', guilds: [OTHER_GUILD] },
  'token-carol': { id: '33', username: 'carol', guilds: [GUILD, OTHER_GUILD] },
}
const tokenRequests = []
const mockFetch = async (url, init = {}) => {
  const u = new URL(url)
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  if (u.pathname.endsWith('/oauth2/token')) {
    const params = new URLSearchParams(init.body)
    tokenRequests.push(Object.fromEntries(params))
    const code = params.get('code')
    return code === 'good-code' ? json({ access_token: 'token-alice' }) : json({ error: 'invalid_grant' }, 400)
  }
  const token = /^Bearer (.+)$/.exec(init.headers?.Authorization ?? '')?.[1]
  const user = USERS[token]
  if (!user) return json({ message: '401' }, 401)
  if (u.pathname.endsWith('/users/@me')) return json({ id: user.id, username: user.username })
  if (u.pathname.endsWith('/users/@me/guilds')) {
    return json(user.guilds.map((id) => ({ id, name: `Guild ${id.slice(-1)}`, icon: id === GUILD ? 'abc123' : null })))
  }
  return json({}, 404)
}

// VoiceBot のフェイク (サーバー権威の判定ロジックだけ本物と同じ形にする)
class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.channels = new Map() // guildId -> channelId
    this.nowPlaying = new Map()
    this.played = []
    this.voice = new Map() // `${guildId}:${userId}` -> channelId
  }
  getUserVoice(g, u) {
    const channelId = this.voice.get(`${g}:${u}`)
    return channelId ? { channelId, channelName: `vc-${channelId.slice(-1)}` } : null
  }
  getState(g) {
    return { botChannelId: this.channels.get(g) ?? null, nowPlaying: this.nowPlaying.get(g) ?? [] }
  }
  async join(g, c) {
    if (c === 'bad') throw new BotError('invalid_channel')
    this.channels.set(g, c)
    this.emit('state', g)
  }
  leave(g) {
    this.channels.delete(g)
    this.nowPlaying.delete(g)
    this.emit('state', g)
  }
  async play(g, c, { filePath, soundId, userId }) {
    if (this.channels.get(g) !== c) return 'not_in_channel'
    if (this.nextResult) {
      const result = this.nextResult
      this.nextResult = null
      return result
    }
    this.played.push({ filePath, soundId })
    // 音は重なる: 再生中でも追加で鳴らせる
    this.nowPlaying.set(g, [...(this.nowPlaying.get(g) ?? []), { id: String(this.played.length), soundId, userId }])
    this.emit('state', g)
    return 'ok'
  }
  stop(g, c, id) {
    if (this.channels.get(g) !== c) return 'not_in_channel'
    const list = this.nowPlaying.get(g) ?? []
    const rest = id === undefined ? [] : list.filter((p) => p.id !== id)
    if (id !== undefined && rest.length === list.length) return 'not_found'
    this.nowPlaying.set(g, rest)
    this.emit('state', g)
    return 'ok'
  }
  finish(g) {
    this.nowPlaying.delete(g)
    this.emit('state', g)
  }
}

let ctx
before(async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-api-'))
  const store = new SoundStore(dataDir)
  const hub = new Hub()
  const bot = new FakeBot()
  const auth = createAuth({ clientId: 'cid', clientSecret: 'secret', fetchImpl: mockFetch })
  const config = { maxUploadBytes: 1024 * 1024, staticDir: path.join(dataDir, 'none'), clientId: 'cid', publicUrl: 'https://sb.example.com' }
  const app = createApp({ config, auth, store, bot, hub })
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((r) => server.once('listening', r))
  const ws = attachWebSocket(server, { auth, hub, bot, store })
  const port = server.address().port
  ctx = { store, hub, bot, server, ws, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` }
})
after(() => {
  ctx.ws.close()
  ctx.server.close()
})

const auth = (token) => ({ Authorization: `Bearer ${token}` })

function upload({ token = 'token-alice', guild = GUILD, name = 'ぱふ', emoji = '🎺', tags, scope, data = beep, headers = {} } = {}) {
  const form = new FormData()
  if (scope) form.set('scope', scope)
  if (tags !== undefined) form.set('tags', JSON.stringify(tags))
  form.set('name', name)
  form.set('emoji', emoji)
  form.set('file', new Blob([data]), 'x.ogg')
  return fetch(`${ctx.base}/api/guilds/${guild}/sounds`, { method: 'POST', headers: { ...auth(token), ...headers }, body: form })
}

/** WSクライアント: 受信メッセージをキューして待てるようにする */
async function connect({ token = 'token-alice', guildId = GUILD, channelId = VC, web } = {}) {
  const ws = new WebSocket(ctx.wsUrl)
  const queue = []
  const waiters = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    const i = waiters.findIndex((w) => w.pred(msg))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
    else queue.push(msg)
  })
  const next = (pred = () => true, ms = 2000) => {
    const i = queue.findIndex(pred)
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { pred, resolve }
      waiters.push(w)
      setTimeout(() => reject(new Error('timeout waiting for ws message')), ms).unref()
    })
  }
  await new Promise((r) => ws.once('open', r))
  ws.send(JSON.stringify({ type: 'hello', token, guildId, channelId, web }))
  return { ws, next, send: (m) => ws.send(JSON.stringify(m)) }
}

test('POST /api/token exchanges code', async () => {
  const ok = await fetch(`${ctx.base}/api/token`, { method: 'POST', body: JSON.stringify({ code: 'good-code' }) })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { access_token: 'token-alice' })
  const bad = await fetch(`${ctx.base}/api/token`, { method: 'POST', body: JSON.stringify({ code: 'nope' }) })
  assert.equal(bad.status, 400)
})

test('guild routes require a token for a guild the user belongs to', async () => {
  const none = await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds`)
  assert.equal(none.status, 401)
  const wrongGuild = await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds`, { headers: auth('token-bob') })
  assert.equal(wrongGuild.status, 403)
  const ok = await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds`, { headers: auth('token-alice') })
  assert.equal(ok.status, 200)
  const traversal = await fetch(`${ctx.base}/api/guilds/..%2F..%2Fetc/sounds`, { headers: auth('token-alice') })
  assert.equal(traversal.status, 400)
})

test('upload validates, stores, lists and deletes sounds', async () => {
  const bad = await upload({ data: Buffer.alloc(500, 1) })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'invalid_audio')

  const noName = await upload({ name: '   ' })
  assert.equal(noName.status, 400)

  const res = await upload({ name: ' ぱふぱふ ', emoji: '🎺🎺' })
  assert.equal(res.status, 201)
  const { sound } = await res.json()
  assert.equal(sound.name, 'ぱふぱふ')
  assert.equal(sound.emoji, '🎺')
  assert.equal(sound.createdBy, '11')
  assert.ok(sound.durationMs > 0)

  const list = await (await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds`, { headers: auth('token-alice') })).json()
  assert.ok(list.sounds.some((s) => s.id === sound.id))

  // 他ギルドの人は触れない
  const del403 = await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds/${sound.id}`, { method: 'DELETE', headers: auth('token-bob') })
  assert.equal(del403.status, 403)

  const del = await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds/${sound.id}`, { method: 'DELETE', headers: auth('token-alice') })
  assert.equal(del.status, 200)
  const again = await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds/${sound.id}`, { method: 'DELETE', headers: auth('token-alice') })
  assert.equal(again.status, 404)
})

test('tags are sanitized on upload and sounds can be edited by owner or guild members', async () => {
  const res = await upload({ name: 'tagged', tags: [' ネタ ', 'ネタ', 'BGM', 'bgm', '', 5, 'x'.repeat(50)] })
  const { sound } = await (await res.json())
  assert.deepEqual(sound.tags, ['ネタ', 'BGM', 'x'.repeat(20)])

  const url = `${ctx.base}/api/guilds/${GUILD}/sounds/${sound.id}`
  const patch = (token, body, u = url) => fetch(u, { method: 'PATCH', headers: auth(token), body: JSON.stringify(body) })

  // 同じサーバーのメンバーは編集できる
  const edited = await patch('token-carol', { name: ' 改名 ', emoji: '🥁🥁', tags: ['a', 'b', 'a'] })
  assert.equal(edited.status, 200)
  const body = (await edited.json()).sound
  assert.deepEqual([body.name, body.emoji, body.tags], ['改名', '🥁', ['a', 'b']])
  assert.ok(body.updatedAt >= sound.updatedAt)

  // 渡した項目だけ変わる
  const partial = (await (await patch('token-alice', { tags: [] })).json()).sound
  assert.deepEqual([partial.name, partial.emoji, partial.tags], ['改名', '🥁', []])

  assert.equal((await patch('token-alice', { name: '  ' })).status, 400)
  assert.equal((await patch('token-alice', 'x')).status, 400)
  assert.equal((await patch('token-bob', { name: 'z' })).status, 403) // サーバーのメンバーではない
  assert.equal((await patch('token-alice', { name: 'z' }, `${ctx.base}/api/guilds/${GUILD}/sounds/00000000-0000-4000-8000-000000000000`)).status, 404)

  await fetch(url, { method: 'DELETE', headers: auth('token-alice') })
})

test('sounds: this server vs mine (across servers), play permission follows', async () => {
  // carol は OTHER_GUILD で追加。alice(GUILD のみ)には見えず、鳴らせない
  const { sound: theirs } = await (await upload({ token: 'token-carol', guild: OTHER_GUILD, name: 'carol-other' })).json()
  const { sound: aliceOwn } = await (await upload({ name: 'alice-own' })).json()

  const aliceList = await (await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds`, { headers: auth('token-alice') })).json()
  assert.ok(aliceList.sounds.some((s) => s.id === aliceOwn.id))
  assert.ok(!aliceList.sounds.some((s) => s.id === theirs.id))
  assert.ok(aliceList.mine.some((s) => s.id === aliceOwn.id))
  assert.ok(aliceList.mine.every((s) => s.createdBy === '11'))

  // carol が GUILD の通話に居るとき: 自分が OTHER_GUILD で追加したものも「自分が追加」に出て、鳴らせる
  const carol = await connect({ token: 'token-carol' })
  const ready = await carol.next((m) => m.type === 'ready')
  assert.ok(!ready.sounds.some((s) => s.id === theirs.id))
  assert.ok(ready.mine.some((s) => s.id === theirs.id))
  assert.ok(ready.sounds.some((s) => s.id === aliceOwn.id))

  const alice = await connect()
  await alice.next((m) => m.type === 'ready')
  await fetch(`${ctx.base}/api/guilds/${GUILD}/bot/join`, { method: 'POST', headers: auth('token-alice'), body: JSON.stringify({ channelId: VC }) })
  await alice.next((m) => m.type === 'state')
  await carol.next((m) => m.type === 'state')

  carol.send({ type: 'play', soundId: theirs.id })
  assert.ok((await carol.next((m) => m.type === 'state' && m.nowPlaying.length >= 1)).nowPlaying.some((p) => p.soundId === theirs.id))
  assert.ok(ctx.bot.played.at(-1).filePath.endsWith(`${theirs.id}.ogg`))

  // alice には他サーバーのサウンドは鳴らせない
  alice.send({ type: 'play', soundId: theirs.id })
  assert.equal((await alice.next((m) => m.type === 'error')).code, 'sound_not_found')

  // carol が自分のサウンドを編集 → carol(別サーバー接続)にも mine として配信される。alice には来ない
  await fetch(`${ctx.base}/api/guilds/${OTHER_GUILD}/sounds/${theirs.id}`, {
    method: 'PATCH',
    headers: auth('token-carol'),
    body: JSON.stringify({ name: 'renamed' }),
  })
  const pushed = await carol.next((m) => m.type === 'sounds')
  assert.equal(pushed.mine.find((s) => s.id === theirs.id).name, 'renamed')
  alice.send({ type: 'ping' })
  assert.equal((await alice.next((m) => m.type === 'sounds' || m.type === 'pong')).type, 'pong')

  // 追加した本人は、別のサーバー経由でも削除できる
  const del = await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds/${theirs.id}`, { method: 'DELETE', headers: auth('token-carol') })
  assert.equal(del.status, 200)
  await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds/${aliceOwn.id}`, { method: 'DELETE', headers: auth('token-alice') })

  ctx.bot.leave(GUILD)
  alice.ws.close()
  carol.ws.close()
})

test('browser login: authorize redirect, callback sets a cookie, session and targets', async () => {
  const noRedirect = { redirect: 'manual' }
  const login = await fetch(`${ctx.base}/auth/login`, noRedirect)
  assert.equal(login.status, 302)
  const location = new URL(login.headers.get('location'))
  assert.equal(location.origin + location.pathname, 'https://discord.com/oauth2/authorize')
  assert.equal(location.searchParams.get('redirect_uri'), 'https://sb.example.com/auth/callback')
  assert.equal(location.searchParams.get('scope'), 'identify guilds')
  const state = location.searchParams.get('state')
  const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('sb_state='))
  assert.match(stateCookie, /HttpOnly/i)

  // state が違えば拒否
  const bad = await fetch(`${ctx.base}/auth/callback?code=good-code&state=wrong`, { ...noRedirect, headers: { Cookie: stateCookie.split(';')[0] } })
  assert.equal(bad.status, 400)
  const noCookie = await fetch(`${ctx.base}/auth/callback?code=good-code&state=${state}`, noRedirect)
  assert.equal(noCookie.status, 400)

  const cb = await fetch(`${ctx.base}/auth/callback?code=good-code&state=${state}`, { ...noRedirect, headers: { Cookie: stateCookie.split(';')[0] } })
  assert.equal(cb.status, 302)
  assert.equal(cb.headers.get('location'), '/')
  assert.equal(tokenRequests.at(-1).redirect_uri, 'https://sb.example.com/auth/callback')
  const tokenCookie = cb.headers.getSetCookie().find((c) => c.startsWith('sb_token='))
  assert.match(tokenCookie, /HttpOnly/i)
  assert.match(tokenCookie, /SameSite=Lax/i)
  assert.match(tokenCookie, /Secure/i)
  const cookie = tokenCookie.split(';')[0]

  assert.equal((await fetch(`${ctx.base}/api/web/session`)).status, 401)
  const session = await (await fetch(`${ctx.base}/api/web/session`, { headers: { Cookie: cookie } })).json()
  assert.equal(session.access_token, 'token-alice')
  assert.deepEqual(session.user, { id: '11', username: 'alice' })
  assert.equal((await fetch(`${ctx.base}/api/web/session`, { headers: { Cookie: 'sb_token=nope-nope-nope' } })).status, 401)

  const logout = await fetch(`${ctx.base}/auth/logout`, { method: 'POST' })
  assert.match(logout.headers.getSetCookie().join(';'), /sb_token=;/)
})

test('browser targets: servers where the user is in a call, flagged by whether the bot is in the same call', async () => {
  const targets = async (token) => (await (await fetch(`${ctx.base}/api/web/targets`, { headers: auth(token) })).json()).targets
  assert.equal((await fetch(`${ctx.base}/api/web/targets`)).status, 401)
  assert.deepEqual(await targets('token-alice'), [], 'user not in a call')

  ctx.bot.voice.set(`${GUILD}:11`, VC)
  let list = await targets('token-alice')
  assert.equal(list.length, 1)
  assert.deepEqual([list[0].guildId, list[0].channelId, list[0].name, list[0].botHere], [GUILD, VC, 'Guild 1', false], 'bot not in a call')

  ctx.bot.channels.set(GUILD, OTHER_VC)
  assert.equal((await targets('token-alice'))[0].botHere, false, 'bot in a different call')
  ctx.bot.channels.set(GUILD, VC)
  assert.equal((await targets('token-alice'))[0].botHere, true)
  assert.deepEqual(await targets('token-bob'), [])

  ctx.bot.channels.delete(GUILD)
  ctx.bot.voice.clear()
})

test('browser can call the bot only into the call the user is in', async () => {
  const join = (token, body) =>
    fetch(`${ctx.base}/api/guilds/${GUILD}/bot/join`, { method: 'POST', headers: auth(token), body: JSON.stringify(body) })

  assert.equal((await join('token-alice', { channelId: VC, web: true })).status, 403, 'not in any call')
  ctx.bot.voice.set(`${GUILD}:11`, OTHER_VC)
  assert.equal((await join('token-alice', { channelId: VC, web: true })).status, 403, 'in a different call')
  assert.equal(ctx.bot.channels.get(GUILD), undefined)

  ctx.bot.voice.set(`${GUILD}:11`, VC)
  const ok = await join('token-alice', { channelId: VC, web: true })
  assert.equal(ok.status, 200)
  assert.equal(ctx.bot.channels.get(GUILD), VC)

  ctx.bot.leave(GUILD)
  ctx.bot.voice.clear()
})

test('browser websocket: needs to be in the bot call, checked at hello and on every action', async () => {
  const { sound } = await (await upload({ name: 'web-play' })).json()
  ctx.bot.channels.set(GUILD, VC)

  // 通話にいない → hello で拒否
  const out = await connect({ web: true })
  assert.equal((await out.next((m) => m.type === 'error')).code, 'not_in_voice')
  await new Promise((r) => out.ws.once('close', r))

  // 別の通話にいる → 拒否
  ctx.bot.voice.set(`${GUILD}:11`, OTHER_VC)
  const wrong = await connect({ web: true })
  assert.equal((await wrong.next((m) => m.type === 'error')).code, 'not_in_voice')
  await new Promise((r) => wrong.ws.once('close', r))

  // 同じ通話 → 鳴らせる
  ctx.bot.voice.set(`${GUILD}:11`, VC)
  const web = await connect({ web: true })
  assert.equal((await web.next((m) => m.type === 'ready')).botChannelId, VC)
  web.send({ type: 'play', soundId: sound.id })
  assert.equal((await web.next((m) => m.type === 'state' && m.nowPlaying.length === 1)).nowPlaying[0].soundId, sound.id)

  // 通話から抜けたら、以降の操作は拒否される (再生・停止とも)
  ctx.bot.voice.delete(`${GUILD}:11`)
  const before = ctx.bot.played.length
  web.send({ type: 'play', soundId: sound.id })
  assert.equal((await web.next((m) => m.type === 'error')).code, 'not_in_voice')
  web.send({ type: 'stopAll' })
  assert.equal((await web.next((m) => m.type === 'error')).code, 'not_in_voice')
  assert.equal(ctx.bot.played.length, before)

  // アクティビティ(web でない)接続は、これまで通りボイスステートを見ない
  const activity = await connect()
  await activity.next((m) => m.type === 'ready')
  activity.send({ type: 'play', soundId: sound.id })
  await activity.next((m) => m.type === 'state' && m.nowPlaying.length === 2)

  ctx.bot.leave(GUILD)
  ctx.bot.voice.clear()
  await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds/${sound.id}`, { method: 'DELETE', headers: auth('token-alice') })
  web.ws.close()
  activity.ws.close()
})

test('personal sounds: belong to no server, visible/playable/editable only by the owner', async () => {
  const { sound } = await (await upload({ name: 'only-me', scope: 'personal' })).json()
  assert.equal(sound.guildId, null)

  const listOf = async (token, guild = GUILD) => await (await fetch(`${ctx.base}/api/guilds/${guild}/sounds`, { headers: auth(token) })).json()
  const alice = await listOf('token-alice')
  assert.ok(!alice.sounds.some((s) => s.id === sound.id), 'not in the server list')
  assert.ok(alice.mine.some((s) => s.id === sound.id), 'in my list')
  const carol = await listOf('token-carol')
  assert.ok(![...carol.sounds, ...carol.mine].some((s) => s.id === sound.id), 'invisible to others')

  const url = `${ctx.base}/api/guilds/${GUILD}/sounds/${sound.id}`
  const patch = await fetch(url, { method: 'PATCH', headers: auth('token-carol'), body: JSON.stringify({ name: 'x' }) })
  assert.equal(patch.status, 403)
  assert.equal((await fetch(url, { method: 'DELETE', headers: auth('token-carol') })).status, 403)

  // 本人は、どのサーバーの通話でも鳴らせ、他人は鳴らせない
  ctx.bot.channels.set(GUILD, VC)
  const carolWs = await connect({ token: 'token-carol' })
  await carolWs.next((m) => m.type === 'ready')
  carolWs.send({ type: 'play', soundId: sound.id })
  assert.equal((await carolWs.next((m) => m.type === 'error')).code, 'sound_not_found')
  const aliceWs = await connect()
  await aliceWs.next((m) => m.type === 'ready')
  aliceWs.send({ type: 'play', soundId: sound.id })
  await aliceWs.next((m) => m.type === 'state' && m.nowPlaying.some((p) => p.soundId === sound.id))

  assert.equal((await fetch(url, { method: 'PATCH', headers: auth('token-alice'), body: JSON.stringify({ name: 'mine!' }) })).status, 200)
  assert.equal((await fetch(url, { method: 'DELETE', headers: auth('token-alice') })).status, 200)
  ctx.bot.leave(GUILD)
  carolWs.ws.close()
  aliceWs.ws.close()
})

test('oversized upload is rejected', async () => {
  // サーバーは本文を読み切る前に 413 を返して接続を閉じるので、keep-alive を再利用させない
  const res = await upload({ data: Buffer.alloc(2 * 1024 * 1024, 1), headers: { Connection: 'close' } })
  assert.equal(res.status, 413)
})

test('websocket: auth, realtime state, play-ignore-while-playing', async () => {
  // 認証失敗
  const bad = await connect({ token: 'token-bob' })
  const err = await bad.next((m) => m.type === 'error')
  assert.equal(err.code, 'not_guild_member')
  await new Promise((r) => bad.ws.once('close', r))

  const { sound } = await (await upload({ name: 'ws-test' })).json()

  const a = await connect()
  const ready = await a.next((m) => m.type === 'ready')
  assert.equal(ready.user.id, '11')
  assert.equal(ready.botChannelId, null)
  assert.deepEqual(ready.guild, {
    id: GUILD,
    name: 'Guild 1',
    iconUrl: `https://cdn.discordapp.com/icons/${GUILD}/abc123.png?size=64`,
  })
  assert.ok(ready.sounds.some((s) => s.id === sound.id))

  // 同じギルドの別クライアントにもリアルタイム配信される
  const b = await connect({ channelId: OTHER_VC })
  await b.next((m) => m.type === 'ready')

  // ボット未参加では再生できない
  a.send({ type: 'play', soundId: sound.id })
  assert.equal((await a.next((m) => m.type === 'error')).code, 'not_in_channel')

  // 参加 (HTTP) → 両クライアントに state が届く
  const join = await fetch(`${ctx.base}/api/guilds/${GUILD}/bot/join`, {
    method: 'POST',
    headers: auth('token-alice'),
    body: JSON.stringify({ channelId: VC }),
  })
  assert.equal(join.status, 200)
  assert.equal((await a.next((m) => m.type === 'state')).botChannelId, VC)
  assert.equal((await b.next((m) => m.type === 'state')).botChannelId, VC)

  // ボットがいない別VCのクライアントは再生できない
  b.send({ type: 'play', soundId: sound.id })
  assert.equal((await b.next((m) => m.type === 'error')).code, 'not_in_channel')

  // 再生 → nowPlaying が配信される
  a.send({ type: 'play', soundId: sound.id })
  const playing = await a.next((m) => m.type === 'state' && m.nowPlaying.length === 1)
  assert.deepEqual(
    playing.nowPlaying.map(({ soundId, userId }) => ({ soundId, userId })),
    [{ soundId: sound.id, userId: '11' }],
  )

  // 再生中にもう一度押すと重なって鳴る (無視されない)
  const before = ctx.bot.played.length
  a.send({ type: 'play', soundId: sound.id })
  const layered = await a.next((m) => m.type === 'state' && m.nowPlaying.length === 2)
  assert.equal(ctx.bot.played.length, before + 1)
  assert.deepEqual(layered.nowPlaying.map((p) => p.soundId), [sound.id, sound.id])

  // 同時再生の上限 (busy) は黙って無視される。エラーは返らない
  ctx.bot.nextResult = 'busy'
  a.send({ type: 'play', soundId: sound.id })
  a.send({ type: 'ping' })
  assert.equal((await a.next((m) => m.type === 'pong' || m.type === 'error')).type, 'pong')

  // ファイルが読めない/展開できないときは play_failed
  ctx.bot.nextResult = 'unreadable'
  a.send({ type: 'play', soundId: sound.id })
  assert.equal((await a.next((m) => m.type === 'error')).code, 'play_failed')
  ctx.bot.nextResult = 'invalid_sound'
  a.send({ type: 'play', soundId: sound.id })
  assert.equal((await a.next((m) => m.type === 'error')).code, 'play_failed')

  // 1つだけ止める → 残りの一覧が配信される。もう無い id や、別の通話からの停止は害がない
  a.send({ type: 'stop', id: layered.nowPlaying[0].id })
  const afterStop = await a.next((m) => m.type === 'state' && m.nowPlaying.length === 1)
  assert.equal(afterStop.nowPlaying[0].id, layered.nowPlaying[1].id)
  a.send({ type: 'stop', id: 'nope' })
  a.send({ type: 'stop', id: 123 })
  a.send({ type: 'ping' })
  assert.equal((await a.next((m) => m.type === 'pong' || m.type === 'error')).type, 'pong')
  b.send({ type: 'stop', id: afterStop.nowPlaying[0].id })
  assert.equal((await b.next((m) => m.type === 'error')).code, 'not_in_channel')

  // 全部止める
  a.send({ type: 'play', soundId: sound.id })
  await a.next((m) => m.type === 'state' && m.nowPlaying.length === 2)
  a.send({ type: 'stopAll' })
  assert.deepEqual((await a.next((m) => m.type === 'state' && m.nowPlaying.length === 0)).nowPlaying, [])
  ctx.bot.nowPlaying.set(GUILD, [{ id: 'x', soundId: sound.id, userId: '11' }])

  // 再生終了 → 空の一覧が配信される
  ctx.bot.finish(GUILD)
  assert.deepEqual((await a.next((m) => m.type === 'state' && m.nowPlaying.length === 0)).nowPlaying, [])

  // 音声追加/削除も配信される
  const { sound: s2 } = await (await upload({ name: 'second' })).json()
  const added = await a.next((m) => m.type === 'sounds')
  assert.ok(added.sounds.some((s) => s.id === s2.id))
  await fetch(`${ctx.base}/api/guilds/${GUILD}/sounds/${s2.id}`, { method: 'DELETE', headers: auth('token-alice') })
  const removed = await a.next((m) => m.type === 'sounds')
  assert.ok(!removed.sounds.some((s) => s.id === s2.id))

  ctx.bot.leave(GUILD)
  a.ws.close()
  b.ws.close()
})
