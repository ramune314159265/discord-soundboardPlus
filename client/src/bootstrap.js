import { DiscordSDK } from '@discord/embedded-app-sdk'
import { createApi, exchangeToken } from './api.js'
import { clientId, isInDiscord } from './env.js'
import { connectSocket } from './socket.js'
import { startWeb } from './webBootstrap.js'
import { appStatusAtom, layoutModeAtom, sessionAtom } from './state.js'

const READY_TIMEOUT_MS = 15_000

/**
 * Discord SDK の初期化 → OAuth2 認証 → WS 接続。
 * サーバーの 'ready' を受け取るまでは appStatus を loading のままにする。
 */
export async function bootstrap(store) {
  const fail = (message) => store.set(appStatusAtom, { status: 'error', message })

  try {
    if (!isInDiscord) return startWeb(store) // アクティビティ外のブラウザ: Discordログイン + 通話に入っていれば操作できる
    if (!clientId) {
      return fail('VITE_DISCORD_CLIENT_ID が設定されていません (.env を確認して再ビルドしてください)')
    }

    const sdk = new DiscordSDK(clientId)
    await sdk.ready()

    // 表示モード (通常 / ミニフローティングウィンドウ / グリッド) の変化を購読する。失敗しても起動は続ける
    try {
      sdk
        .subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode: mode }) => store.set(layoutModeAtom, mode))
        .catch((err) => console.warn('[bootstrap] layout mode subscription failed:', err))
    } catch (err) {
      console.warn('[bootstrap] layout mode subscription failed:', err)
    }

    if (!sdk.guildId) return fail('サーバーのボイスチャンネルでアクティビティを起動してください (DMでは使えません)')
    if (!sdk.channelId) return fail('チャンネル情報を取得できませんでした')

    store.set(appStatusAtom, { status: 'loading', message: '認証中…' })
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify', 'guilds'],
    })
    const { access_token: token } = await exchangeToken(code)
    const auth = await sdk.commands.authenticate({ access_token: token })
    if (!auth) return fail('Discordでの認証に失敗しました')

    const guildId = sdk.guildId
    const channelId = sdk.channelId
    store.set(sessionAtom, {
      api: createApi({ token, guildId }),
      guildId,
      channelId,
      user: { id: auth.user.id, username: auth.user.global_name || auth.user.username },
    })

    store.set(appStatusAtom, { status: 'loading', message: 'サーバーに接続中…' })
    const readyTimer = setTimeout(() => fail('サーバーに接続できませんでした'), READY_TIMEOUT_MS)
    connectSocket(store, {
      token,
      guildId,
      channelId,
      onFirstReady: () => {
        clearTimeout(readyTimer)
        store.set(appStatusAtom, { status: 'ready' })
      },
      onFatal: (message) => {
        clearTimeout(readyTimer)
        fail(message)
      },
    })
  } catch (err) {
    console.error('[bootstrap]', err)
    fail(err?.message || '起動に失敗しました')
  }
}
