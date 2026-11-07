import crypto from 'node:crypto'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { AuthError } from './auth.js'

const TOKEN_COOKIE = 'sb_token'
const STATE_COOKIE = 'sb_state'
const MAX_COOKIE_SECONDS = 7 * 24 * 3600

/**
 * アクティビティの外 (スマホのブラウザなど) から使うための、Discord ログインと「いま鳴らせる通話」の一覧。
 *
 *   GET  /auth/login     Discord の認可画面へ
 *   GET  /auth/callback  code を交換し、アクセストークンを HttpOnly の Cookie に入れてトップへ戻す
 *   POST /auth/logout    Cookie を消す
 *   GET  /api/web/session  Cookie のトークンを返す (ページが API/WS に使う)
 *   GET  /api/web/targets  自分が通話に入っているサーバーの一覧。botHere: ボットも同じ通話にいる (Authorization: Bearer)
 *
 * 鳴らせる条件は、ボットがいる通話に、その人もいること (サーバー側のボイスステートで確認)。
 */
export function registerWebRoutes(app, { config, auth, bot, bearer }) {
  const secure = config.publicUrl.startsWith('https://')
  const redirectUri = `${config.publicUrl}/auth/callback`

  const cookieBase = { httpOnly: true, sameSite: 'Lax', secure }

  app.get('/auth/login', (c) => {
    if (!config.publicUrl) return c.text('PUBLIC_URL が設定されていないため、ブラウザからのログインは使えません。', 503)
    const state = crypto.randomBytes(16).toString('hex')
    setCookie(c, STATE_COOKIE, state, { ...cookieBase, path: '/auth', maxAge: 600 })
    const url = new URL('https://discord.com/oauth2/authorize')
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      scope: 'identify guilds',
      redirect_uri: redirectUri,
      state,
      prompt: 'none', // 認可済みなら確認画面を省く
    }).toString()
    return c.redirect(url.toString())
  })

  app.get('/auth/callback', async (c) => {
    const expected = getCookie(c, STATE_COOKIE)
    deleteCookie(c, STATE_COOKIE, { path: '/auth' })
    const state = c.req.query('state')
    const code = c.req.query('code')
    if (!expected || !state || state.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      return c.text('ログインの状態が一致しません。もう一度お試しください。', 400)
    }
    if (!code) return c.redirect('/') // 認可を拒否した場合など
    const { accessToken, expiresIn } = await auth.exchangeCodeFull(code, redirectUri)
    setCookie(c, TOKEN_COOKIE, accessToken, { ...cookieBase, path: '/', maxAge: Math.min(expiresIn, MAX_COOKIE_SECONDS) })
    return c.redirect('/')
  })

  app.post('/auth/logout', (c) => {
    deleteCookie(c, TOKEN_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/api/web/session', async (c) => {
    const token = getCookie(c, TOKEN_COOKIE)
    if (!token) return c.json({ error: 'not_logged_in' }, 401)
    try {
      const session = await auth.getSession(token)
      return c.json({ access_token: token, user: { id: session.userId, username: session.username } })
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) {
        deleteCookie(c, TOKEN_COOKIE, { path: '/' })
        return c.json({ error: 'not_logged_in' }, 401)
      }
      throw err
    }
  })

  app.get('/api/web/targets', async (c) => {
    const session = await auth.getSession(bearer(c))
    const targets = []
    for (const [guildId, guild] of session.guilds) {
      const voice = bot.getUserVoice(guildId, session.userId)
      if (!voice) continue
      const botChannelId = bot.getState(guildId).botChannelId
      // botHere: ボットが自分と同じ通話にいる (鳴らせる)。そうでなければ「ボットを呼ぶ」対象
      targets.push({
        guildId,
        name: guild.name,
        iconUrl: guild.iconUrl,
        channelId: voice.channelId,
        channelName: voice.channelName,
        botHere: botChannelId === voice.channelId,
      })
    }
    return c.json({ user: { id: session.userId, username: session.username }, targets })
  })
}
