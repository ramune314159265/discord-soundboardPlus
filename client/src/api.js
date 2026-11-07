import { apiUrl } from './env.js'

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code)
    this.code = code
    this.status = status
  }
}

const MESSAGES = {
  bot_not_in_guild: 'ボットがこのサーバーに参加していません。先にボットを招待してください',
  invalid_channel: 'このチャンネルにはボットを参加させられません',
  no_permission: 'ボットにこのチャンネルへの接続/発言権限がありません',
  connect_timeout: 'ボイスチャンネルへの接続がタイムアウトしました',
  disconnected: '参加の途中でボットが通話から切断されました。もう一度お試しください',
  file_too_large: 'ファイルが大きすぎます',
  invalid_audio: '音声ファイルとして不正です',
  invalid_name: '名前を入力してください',
  not_guild_member: 'このサーバーのメンバーではありません',
  invalid_token: '認証の有効期限が切れました。アクティビティを開き直してください',
  not_in_voice: 'ボットのいる通話に参加していないため操作できません',
  not_in_channel: 'ボットがこの通話にいません',
  not_ready: 'ボットの接続準備中です。少し待ってからもう一度お試しください',
  forbidden: 'このサウンドは編集・削除できません',
  sound_not_found: 'そのサウンドは削除されています',
  play_failed: 'このサウンドを再生できませんでした',
  rate_limited: 'Discord APIが混み合っています。少し待ってからお試しください',
}

export function errorMessage(code, fallback = 'エラーが発生しました') {
  return MESSAGES[code] || fallback
}

async function request(method, path, { token, json, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (json !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
    })
  } catch (err) {
    throw new ApiError('network_error', 'サーバーに接続できませんでした', 0, { cause: err })
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = data.error || `http_${res.status}`
    throw new ApiError(code, errorMessage(code, data.message), res.status)
  }
  return data
}

/** ブラウザ(アクティビティ外): ログイン済みならトークンを返す。未ログインは null */
export async function fetchWebSession() {
  try {
    return await request('GET', '/api/web/session')
  } catch (err) {
    if (err.status === 401) return null
    throw err
  }
}

/** ブラウザ(アクティビティ外): いま鳴らせる通話 (ボットのいる通話に自分もいるサーバー) の一覧 */
export function fetchWebTargets(token) {
  return request('GET', '/api/web/targets', { token })
}

export function webLogout() {
  return request('POST', '/auth/logout')
}

export function exchangeToken(code) {
  return request('POST', '/api/token', { json: { code } })
}

/** ギルド単位のAPIクライアント */
export function createApi({ token, guildId }) {
  const base = `/api/guilds/${guildId}`
  return {
    uploadSound({ blob, name, emoji, tags = [], personal = false }) {
      const form = new FormData()
      form.set('name', name)
      form.set('emoji', emoji)
      form.set('tags', JSON.stringify(tags))
      if (personal) form.set('scope', 'personal')
      form.set('file', blob, 'sound.ogg')
      return request('POST', `${base}/sounds`, { token, body: form })
    },
    updateSound(soundId, patch) {
      return request('PATCH', `${base}/sounds/${soundId}`, { token, json: patch })
    },
    deleteSound(soundId) {
      return request('DELETE', `${base}/sounds/${soundId}`, { token })
    },
    /** web: ブラウザ(アクティビティ外)から。サーバー側で「本人がその通話にいるか」を確認する */
    joinBot(channelId, { web = false } = {}) {
      return request('POST', `${base}/bot/join`, { token, json: { channelId, ...(web ? { web: true } : {}) } })
    },
    leaveBot() {
      return request('POST', `${base}/bot/leave`, { token })
    },
  }
}
