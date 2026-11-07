import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parseNonNegative(value, fallback) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 環境変数から設定を組み立てる。
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR || './data')
  return {
    clientId: env.DISCORD_CLIENT_ID || '',
    clientSecret: env.DISCORD_CLIENT_SECRET || '',
    botToken: env.DISCORD_BOT_TOKEN || '',
    port: Number(env.PORT) || 3000,
    dataDir,
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES) || 8 * 1024 * 1024,
    // 通話にボット以外が誰もいなくなってから自動退出するまでの猶予 (ミリ秒)。0 なら即時
    autoLeaveDelayMs: parseNonNegative(env.AUTO_LEAVE_DELAY_MS, 5_000),
    discordApiBase: env.DISCORD_API_BASE || 'https://discord.com/api/v10',
    // ブラウザ(アクティビティ外)からのログインに使う、このサーバーの公開URL。末尾の / は除く。例: https://example.com
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    staticDir: path.resolve(ROOT_DIR, 'client/dist'),
  }
}

/** 起動に必須の設定が揃っているか確認し、不足していれば名前の配列を返す */
export function missingConfig(config) {
  const missing = []
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID')
  if (!config.clientSecret) missing.push('DISCORD_CLIENT_SECRET')
  if (!config.botToken) missing.push('DISCORD_BOT_TOKEN')
  return missing
}
