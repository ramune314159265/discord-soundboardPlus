/** ギルドアイコンのURL。アイコン未設定なら null (クライアントは頭文字で代替する) */
export function guildIconUrl(guildId, iconHash) {
  if (typeof iconHash !== 'string' || !/^(a_)?[0-9a-f]+$/.test(iconHash)) return null
  const ext = iconHash.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${ext}?size=64`
}

export class AuthError extends Error {
  constructor(code, status = 401, message = code) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Discord OAuth2 の code 交換と、アクセストークンからのユーザー/所属ギルド確認。
 * クライアントが送る guildId は信用せず、トークンで取得した所属ギルドと突き合わせる。
 */
export function createAuth({
  clientId,
  clientSecret,
  apiBase = 'https://discord.com/api/v10',
  fetchImpl = fetch,
  ttlMs = 5 * 60_000,
  maxEntries = 500,
}) {
  /** @type {Map<string, { expires: number, promise: Promise<{ userId: string, username: string, guildIds: Set<string>, guilds: Map<string, { id: string, name: string, iconUrl: string | null }> }> }>} */
  const sessions = new Map()

  async function discordGet(pathname, token) {
    const res = await fetchImpl(`${apiBase}${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401 || res.status === 403) throw new AuthError('invalid_token', 401)
    if (res.status === 429) throw new AuthError('rate_limited', 503, 'Discord API rate limited')
    if (!res.ok) throw new AuthError('discord_api_error', 502, `Discord API ${res.status}`)
    return res.json()
  }

  /** ユーザーの所属ギルド一覧 (id → { id, name, iconUrl }) */
  async function fetchAllGuilds(token) {
    const guilds = new Map()
    let after
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '200' })
      if (after) query.set('after', after)
      const batch = await discordGet(`/users/@me/guilds?${query}`, token)
      for (const g of batch) {
        const id = String(g.id)
        guilds.set(id, { id, name: typeof g.name === 'string' ? g.name : '', iconUrl: guildIconUrl(id, g.icon) })
      }
      if (batch.length < 200) break
      after = String(batch[batch.length - 1].id)
    }
    return guilds
  }

  async function loadSession(token) {
    const [me, guilds] = await Promise.all([discordGet('/users/@me', token), fetchAllGuilds(token)])
    return {
      userId: String(me.id),
      username: me.global_name || me.username || '',
      guildIds: new Set(guilds.keys()),
      guilds,
    }
  }

  function prune(now) {
    if (sessions.size < maxEntries) return
    for (const [key, entry] of sessions) {
      if (entry.expires <= now) sessions.delete(key)
    }
    // それでも多ければ古い順に捨てる
    while (sessions.size >= maxEntries) {
      sessions.delete(sessions.keys().next().value)
    }
  }

  return {
    /** OAuth2 code → access_token (アクティビティ用。redirect_uri は不要) */
    async exchangeCode(code) {
      return (await this.exchangeCodeFull(code)).accessToken
    },

    /**
     * OAuth2 code → { accessToken, expiresIn(秒) }。
     * ブラウザのログイン(認可コードフロー)では、認可時と同じ redirectUri を渡す必要がある。
     */
    async exchangeCodeFull(code, redirectUri) {
      if (typeof code !== 'string' || !code || code.length > 512) throw new AuthError('invalid_code', 400)
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
      })
      if (redirectUri) body.set('redirect_uri', redirectUri)
      const res = await fetchImpl(`${apiBase}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (!res.ok) throw new AuthError('code_exchange_failed', 400, `token exchange failed (${res.status})`)
      const json = await res.json()
      if (!json.access_token) throw new AuthError('code_exchange_failed', 400)
      const expiresIn = Number(json.expires_in)
      return { accessToken: json.access_token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600 }
    },

    /** トークンからセッション情報を得る (短時間キャッシュ) */
    async getSession(token) {
      if (typeof token !== 'string' || token.length < 8 || token.length > 512) throw new AuthError('invalid_token')
      const now = Date.now()
      const cached = sessions.get(token)
      if (cached && cached.expires > now) return cached.promise

      prune(now)
      const promise = loadSession(token)
      sessions.set(token, { expires: now + ttlMs, promise })
      promise.catch(() => sessions.delete(token))
      return promise
    },

    /** そのユーザーが guildId のメンバーであることを確認し、セッションを返す */
    async assertGuildMember(token, guildId) {
      const session = await this.getSession(token)
      if (!session.guildIds.has(guildId)) throw new AuthError('not_guild_member', 403)
      return session
    },
  }
}
