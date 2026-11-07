import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { AuthError } from './auth.js'
import { BotError } from './bot.js'
import { inspectOgg } from './ogg.js'
import { isGuildId, isSoundId } from './store.js'
import { registerWebRoutes } from './web.js'

const SNOWFLAKE_RE = /^\d{1,25}$/
const MAX_NAME_LENGTH = 40
const MAX_TAG_LENGTH = 20
const MAX_TAGS = 10

export function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value)
}

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return ''
  // 制御文字を除去し、空白を詰めて長さを制限
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join('')
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function sanitizeEmoji(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!trimmed) return ''
  // 先頭の1書記素のみ (絵文字1つ分)
  const first = segmenter.segment(trimmed)[Symbol.iterator]().next().value
  return first ? first.segment.slice(0, 16) : ''
}

/** タグ配列を整える: 文字列のみ・制御文字除去・空白詰め・長さ制限・重複除去(大文字小文字無視)・個数制限 */
export function sanitizeTags(raw) {
  let list = raw
  if (typeof raw === 'string') {
    // フォームでは JSON 配列 か カンマ区切りで受ける
    try {
      list = JSON.parse(raw)
    } catch {
      list = raw.split(',')
    }
  }
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const tags = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const tag = [...item.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()].slice(0, MAX_TAG_LENGTH).join('')
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

function bearer(c) {
  const header = c.req.header('Authorization') || ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match ? match[1] : ''
}

const BOT_ERROR_STATUS = {
  bot_not_in_guild: 409,
  invalid_channel: 400,
  no_permission: 403,
  connect_timeout: 504,
  disconnected: 409,
}

/**
 * @param {{
 *   config: ReturnType<import('./config.js').loadConfig>,
 *   auth: ReturnType<import('./auth.js').createAuth>,
 *   store: import('./store.js').SoundStore,
 *   bot: import('./bot.js').VoiceBot,
 *   hub: import('./hub.js').Hub,
 * }} deps
 */
export function createApp({ config, auth, store, bot, hub }) {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.code, message: err.message }, err.status)
    if (err instanceof BotError) {
      return c.json({ error: err.code, message: err.message }, BOT_ERROR_STATUS[err.code] ?? 500)
    }
    console.error('[http] unhandled error:', err)
    return c.json({ error: 'internal_error', message: 'Internal Server Error' }, 500)
  })

  app.get('/api/health', (c) => c.json({ ok: true }))

  // OAuth2 code → access_token
  app.post('/api/token', bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const body = await c.req.json().catch(() => null)
    const accessToken = await auth.exchangeCode(body?.code)
    return c.json({ access_token: accessToken })
  })

  // アクティビティ外(ブラウザ)からのログインと、鳴らせる通話の一覧
  registerWebRoutes(app, { config, auth, bot, bearer })

  // /api/guilds/:guildId/* は所属ギルドのメンバーのみ
  app.use('/api/guilds/:guildId/*', async (c, next) => {
    const guildId = c.req.param('guildId')
    if (!isGuildId(guildId)) return c.json({ error: 'invalid_guild' }, 400)
    const session = await auth.assertGuildMember(bearer(c), guildId)
    c.set('session', session)
    await next()
  })

  app.get('/api/guilds/:guildId/sounds', async (c) => {
    const guildId = c.req.param('guildId')
    return c.json(await soundLists(store, guildId, c.get('session').userId))
  })

  app.get('/api/guilds/:guildId/state', (c) => {
    return c.json(bot.getState(c.req.param('guildId')))
  })

  app.post(
    '/api/guilds/:guildId/sounds',
    bodyLimit({
      maxSize: config.maxUploadBytes + 64 * 1024,
      onError: (c) => c.json({ error: 'file_too_large', message: 'ファイルが大きすぎます' }, 413),
    }),
    async (c) => {
      const guildId = c.req.param('guildId')
      const session = c.get('session')

      const form = await c.req.parseBody().catch(() => null)
      const file = form?.file
      if (!file || typeof file === 'string') return c.json({ error: 'missing_file' }, 400)
      if (file.size > config.maxUploadBytes) {
        return c.json({ error: 'file_too_large', message: 'ファイルが大きすぎます' }, 413)
      }

      const name = sanitizeName(form.name)
      if (!name) return c.json({ error: 'invalid_name', message: '名前を入力してください' }, 400)
      const emoji = sanitizeEmoji(form.emoji)

      const data = Buffer.from(await file.arrayBuffer())
      const info = inspectOgg(data)
      if (!info.ok) return c.json({ error: 'invalid_audio', message: `Ogg/Opusとして不正です (${info.error})` }, 400)

      // scope=personal: どのサーバーにも属さず、追加した本人だけのサウンドにする
      const personal = form.scope === 'personal'
      const sound = await store.add({
        guildId: personal ? null : guildId,
        name,
        emoji,
        tags: sanitizeTags(form.tags),
        data,
        durationMs: info.durationMs,
        createdBy: session.userId,
      })
      await pushSounds(hub, store, sound)
      return c.json({ sound }, 201)
    },
  )

  // 編集・削除できるのは、追加した本人か、そのサウンドのあるサーバーのメンバー
  async function loadEditable(c) {
    const soundId = c.req.param('soundId')
    if (!isSoundId(soundId)) return { error: c.json({ error: 'invalid_sound' }, 400) }
    const sound = await store.get(soundId)
    if (!sound) return { error: c.json({ error: 'sound_not_found' }, 404) }
    const { userId } = c.get('session')
    if (sound.createdBy !== userId && sound.guildId !== c.req.param('guildId')) {
      return { error: c.json({ error: 'forbidden', message: 'このサウンドは編集できません' }, 403) }
    }
    return { sound }
  }

  app.patch('/api/guilds/:guildId/sounds/:soundId', bodyLimit({ maxSize: 8192 }), async (c) => {
    const { sound, error } = await loadEditable(c)
    if (error) return error
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: 'bad_request' }, 400)

    const patch = {}
    if (body.name !== undefined) {
      const name = sanitizeName(body.name)
      if (!name) return c.json({ error: 'invalid_name', message: '名前を入力してください' }, 400)
      patch.name = name
    }
    if (body.emoji !== undefined) patch.emoji = sanitizeEmoji(body.emoji)
    if (body.tags !== undefined) patch.tags = sanitizeTags(body.tags)

    const updated = await store.update(sound.id, patch)
    if (!updated) return c.json({ error: 'sound_not_found' }, 404)
    await pushSounds(hub, store, updated)
    return c.json({ sound: updated })
  })

  app.delete('/api/guilds/:guildId/sounds/:soundId', async (c) => {
    const { sound, error } = await loadEditable(c)
    if (error) return error
    const removed = await store.remove(sound.id)
    if (!removed) return c.json({ error: 'sound_not_found' }, 404)
    await pushSounds(hub, store, sound)
    return c.json({ ok: true })
  })

  // ボットをアクティビティが動いているVCに参加(または移動)させる
  app.post('/api/guilds/:guildId/bot/join', bodyLimit({ maxSize: 4096 }), async (c) => {
    const guildId = c.req.param('guildId')
    const body = await c.req.json().catch(() => null)
    if (!isSnowflake(body?.channelId)) return c.json({ error: 'invalid_channel' }, 400)
    // ブラウザ(アクティビティ外)からは、本人が今いる通話にしか呼べない
    if (body.web === true && bot.getUserVoice(guildId, c.get('session').userId)?.channelId !== body.channelId) {
      return c.json({ error: 'not_in_voice', message: 'ボットを呼べるのは、自分が参加している通話だけです' }, 403)
    }
    await bot.join(guildId, body.channelId)
    return c.json(bot.getState(guildId))
  })

  app.post('/api/guilds/:guildId/bot/leave', (c) => {
    const guildId = c.req.param('guildId')
    bot.leave(guildId)
    return c.json(bot.getState(guildId))
  })

  // 未定義の API は SPA のフォールバックに落とさず 404 を返す
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

  // ビルド済みクライアントの配信 (存在する場合のみ)
  if (fs.existsSync(path.join(config.staticDir, 'index.html'))) {
    const rel = path.relative(process.cwd(), config.staticDir) || '.'
    const onFound = (filePath, c) => {
      if (filePath.endsWith('index.html')) c.header('Cache-Control', 'no-cache')
      else if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes('/assets/')) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable')
      }
    }
    app.use('*', serveStatic({ root: rel, onFound }))
    app.get('*', serveStatic({ root: rel, path: 'index.html', onFound }))
  }

  return app
}

/** そのユーザーが見るサウンド: 今のサーバーのもの(guild)と、自分が追加したもの(mine) */
export async function soundLists(store, guildId, userId) {
  const [guild, mine] = await Promise.all([store.listByGuild(guildId), store.listByOwner(userId)])
  return { sounds: guild, mine }
}

/** サウンドの増減・編集を、影響を受ける接続 (同じサーバー or 追加した本人) へ配信する */
export async function pushSounds(hub, store, sound) {
  for (const client of hub.clients()) {
    if (client.guildId !== sound.guildId && client.userId !== sound.createdBy) continue
    if (client.ws.readyState !== 1) continue
    const lists = await soundLists(store, client.guildId, client.userId)
    client.ws.send(JSON.stringify({ type: 'sounds', ...lists }))
  }
}
