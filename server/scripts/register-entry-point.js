// 手動実行用: npm run register-commands
import path from 'node:path'
import dotenv from 'dotenv'
import { ROOT_DIR, loadConfig } from '../src/config.js'
import { ensureEntryPoint } from '../src/entryPoint.js'

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true })
const config = loadConfig()

try {
  const { action, command } = await ensureEntryPoint({
    applicationId: config.clientId,
    botToken: config.botToken,
    apiBase: config.discordApiBase,
  })
  const label = { created: '作成しました', updated: 'handler を修正しました', unchanged: '登録済みです (変更なし)' }[action]
  console.log(`エントリーポイントコマンド "${command.name}" (id: ${command.id}) ${label}`)
} catch (err) {
  console.error(`エントリーポイントコマンドの登録に失敗しました: ${err.message}`)
  process.exit(1)
}
