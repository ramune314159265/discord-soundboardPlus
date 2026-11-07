// Activity を App Launcher から起動するための「エントリーポイントコマンド」を用意する。
// https://docs.discord.com/developers/interactions/application-commands#entry-point-commands
//
//   type 4 = PRIMARY_ENTRY_POINT (アプリにつきグローバルで1つだけ)
//   handler 2 = DISCORD_LAUNCH_ACTIVITY (Discord 側で起動するので、こちらのインタラクション処理は不要)
//
// Activities を有効化すると Discord が "Launch" を自動作成するが、コマンドを一括上書き(PUT)した
// 場合などに無くなることがあるため、無ければ作成し、handler が違えば直す (冪等)。

export const PRIMARY_ENTRY_POINT = 4
export const DISCORD_LAUNCH_ACTIVITY = 2

export class EntryPointError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'EntryPointError'
    this.status = status
  }
}

/**
 * @param {{
 *   applicationId: string,
 *   botToken: string,
 *   apiBase?: string,
 *   fetchImpl?: typeof fetch,
 *   name?: string,
 *   description?: string,
 * }} options
 * @returns {Promise<{ action: 'created' | 'updated' | 'unchanged', command: object }>}
 */
export async function ensureEntryPoint({
  applicationId,
  botToken,
  apiBase = 'https://discord.com/api/v10',
  fetchImpl = fetch,
  name = 'launch',
  description = 'サウンドボードを起動します',
}) {
  if (!applicationId || !botToken) throw new EntryPointError('applicationId と botToken が必要です')

  const base = `${apiBase}/applications/${applicationId}/commands`
  const headers = { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' }

  async function call(url, init) {
    const res = await fetchImpl(url, { ...init, headers })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const hint =
        res.status === 401
          ? ' (ボットトークンが正しくありません)'
          : res.status === 403
            ? ' (権限がありません。DISCORD_CLIENT_ID がボットのアプリと一致しているか確認してください)'
            : ''
      throw new EntryPointError(`Discord API ${res.status}${hint}: ${detail.slice(0, 300)}`, res.status)
    }
    return res.json()
  }

  const commands = await call(base, { method: 'GET' })
  const existing = commands.find((c) => c.type === PRIMARY_ENTRY_POINT)

  if (!existing) {
    const command = await call(base, {
      method: 'POST',
      body: JSON.stringify({ name, description, type: PRIMARY_ENTRY_POINT, handler: DISCORD_LAUNCH_ACTIVITY }),
    })
    return { action: 'created', command }
  }

  if (existing.handler !== DISCORD_LAUNCH_ACTIVITY) {
    const command = await call(`${base}/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ handler: DISCORD_LAUNCH_ACTIVITY }),
    })
    return { action: 'updated', command }
  }

  return { action: 'unchanged', command: existing }
}
