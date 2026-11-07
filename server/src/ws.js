import { WebSocketServer } from 'ws'
import { isSnowflake, soundLists } from './routes.js'
import { isSoundId } from './store.js'

const HELLO_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * クライアント → サーバー
 *   { type: 'hello', token, guildId, channelId, web? }   // web: アクティビティ外のブラウザ。ボットのいる通話に本人もいるときだけ操作できる
 *   { type: 'play', soundId }
 *   { type: 'stop', id }        // 鳴っている音を1つ止める (id は nowPlaying の id)
 *   { type: 'stopAll' }         // 鳴っている音を全部止める
 *   { type: 'ping' }
 * サーバー → クライアント
 *   { type: 'ready', user: { id, username }, guild: { id, name, iconUrl } | null, limits: { maxUploadBytes }, sounds, botChannelId, nowPlaying }
 *   { type: 'state', botChannelId, nowPlaying }   // nowPlaying: { id, soundId, userId }[] (同じサウンドが重なれば複数並ぶ)
 *   { type: 'sounds', sounds, mine }   // sounds: このサーバーのサウンド / mine: 自分が追加したサウンド (他サーバー分も含む)
 *   { type: 'error', code }
 *   { type: 'pong' }
 */
export function attachWebSocket(server, { auth, hub, bot, store, maxUploadBytes }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })

  server.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try {
      pathname = new URL(req.url, 'http://localhost').pathname
    } catch {
      /* noop */
    }
    if (pathname !== '/ws') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws))
  })

  // ボット状態の変化をギルドのルームへ配信
  const onBotState = (guildId) => {
    hub.broadcast(guildId, { type: 'state', ...bot.getState(guildId) })
  }
  bot.on('state', onBotState)

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  function send(ws, message) {
    if (ws.readyState === 1) ws.send(JSON.stringify(message))
  }

  function onConnection(ws) {
    ws.isAlive = true
    ws.on('pong', () => {
      ws.isAlive = true
    })

    /** @type {{ ws: import('ws').WebSocket, guildId: string, channelId: string, userId: string, token: string } | null} */
    let client = null
    let helloing = false
    const helloTimer = setTimeout(() => {
      if (!client) ws.close(4001, 'hello timeout')
    }, HELLO_TIMEOUT_MS)

    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (client) hub.remove(client)
    })
    ws.on('error', () => {})

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg || typeof msg.type !== 'string') return

      try {
        if (!client) {
          if (msg.type !== 'hello' || helloing) return
          helloing = true
          await handleHello(msg)
          return
        }
        await handleMessage(msg)
      } catch (err) {
        if (!client) {
          send(ws, { type: 'error', code: err.code || 'internal_error' })
          ws.close(4003, 'auth failed')
        } else {
          send(ws, { type: 'error', code: err.code || 'internal_error' })
        }
      } finally {
        helloing = false
      }
    })

    async function handleHello(msg) {
      if (!isSnowflake(msg.guildId) || !isSnowflake(msg.channelId)) {
        const err = new Error('bad hello')
        err.code = 'bad_request'
        throw err
      }
      const session = await auth.assertGuildMember(msg.token, msg.guildId)
      const web = msg.web === true
      if (web && bot.getUserVoice(msg.guildId, session.userId)?.channelId !== msg.channelId) {
        const err = new Error('not in voice')
        err.code = 'not_in_voice'
        throw err
      }
      clearTimeout(helloTimer)
      client = { ws, guildId: msg.guildId, channelId: msg.channelId, userId: session.userId, token: msg.token, web }
      hub.add(client)
      send(ws, {
        type: 'ready',
        user: { id: session.userId, username: session.username },
        guild: session.guilds.get(client.guildId) ?? null,
        limits: { maxUploadBytes },
        ...(await soundLists(store, client.guildId, client.userId)),
        ...bot.getState(client.guildId),
      })
    }

    /** ブラウザからの操作は、そのたびに「ボットのいる通話に本人もいるか」を確認する */
    function inVoice() {
      if (!client.web) return true
      if (bot.getUserVoice(client.guildId, client.userId)?.channelId === client.channelId) return true
      send(ws, { type: 'error', code: 'not_in_voice' })
      return false
    }

    async function handleMessage(msg) {
      switch (msg.type) {
        case 'ping':
          send(ws, { type: 'pong' })
          return
        case 'play': {
          if (!isSoundId(msg.soundId)) return
          if (!inVoice()) return
          // 所属ギルドの確認 (キャッシュ有り)
          await auth.assertGuildMember(client.token, client.guildId)
          const sound = await store.get(msg.soundId)
          // 今のサーバーのサウンドか、自分が追加したサウンドだけ鳴らせる
          if (!sound || (sound.guildId !== client.guildId && sound.createdBy !== client.userId)) {
            send(ws, { type: 'error', code: 'sound_not_found' })
            return
          }
          const result = await bot.play(client.guildId, client.channelId, {
            filePath: store.filePath(sound.id),
            soundId: sound.id,
            userId: client.userId,
          })
          // 'busy' (同時再生の上限) は黙って無視する
          if (result === 'not_in_channel' || result === 'not_ready') {
            send(ws, { type: 'error', code: result })
          } else if (result === 'unreadable' || result === 'invalid_sound') {
            send(ws, { type: 'error', code: 'play_failed' })
          }
          return
        }
        case 'stop': {
          if (typeof msg.id !== 'string' || msg.id.length > 20) return
          if (!inVoice()) return
          await auth.assertGuildMember(client.token, client.guildId)
          const result = bot.stop(client.guildId, client.channelId, msg.id)
          // not_found (もう終わっていた) は黙って無視する。止めたかった結果にはなっているため
          if (result === 'not_in_channel') send(ws, { type: 'error', code: result })
          return
        }
        case 'stopAll': {
          if (!inVoice()) return
          await auth.assertGuildMember(client.token, client.guildId)
          const result = bot.stop(client.guildId, client.channelId)
          if (result === 'not_in_channel') send(ws, { type: 'error', code: result })
          return
        }
        default:
          return
      }
    }
  }

  return {
    wss,
    close() {
      clearInterval(heartbeat)
      bot.off('state', onBotState)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
  }
}
