import path from 'node:path'
import dotenv from 'dotenv'
import { serve } from '@hono/node-server'
import { ROOT_DIR, loadConfig, missingConfig } from './config.js'

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true })

const { createAuth } = await import('./auth.js')
const { VoiceBot } = await import('./bot.js')
const { Hub } = await import('./hub.js')
const { SoundStore } = await import('./store.js')
const { createApp } = await import('./routes.js')
const { attachWebSocket } = await import('./ws.js')
const { ensureEntryPoint } = await import('./entryPoint.js')

const config = loadConfig()
const missing = missingConfig(config)
if (missing.length > 0) {
  console.error(`環境変数が不足しています: ${missing.join(', ')}\n.env.example を .env にコピーして設定してください。`)
  process.exit(1)
}

const store = new SoundStore(config.dataDir)
const hub = new Hub()
const auth = createAuth({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  apiBase: config.discordApiBase,
})
const bot = new VoiceBot({ autoLeaveDelayMs: config.autoLeaveDelayMs })
await bot.start(config.botToken)

// App Launcher から Activity を起動するためのエントリーポイントコマンドを用意 (冪等)。
// 失敗してもサーバー自体は動かす。手動実行: npm run register-commands
try {
  const { action, command } = await ensureEntryPoint({
    applicationId: config.clientId,
    botToken: config.botToken,
    apiBase: config.discordApiBase,
  })
  console.log(`[entry-point] "${command.name}" ${action}`)
} catch (err) {
  console.warn(`[entry-point] 登録に失敗しました: ${err.message}`)
}

const app = createApp({ config, auth, store, bot, hub })
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`)
  console.log(`[server] data dir: ${config.dataDir}`)
})
const ws = attachWebSocket(server, { auth, hub, bot, store, maxUploadBytes: config.maxUploadBytes })

async function shutdown() {
  console.log('[server] shutting down...')
  ws.close()
  server.close()
  await bot.stop().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
