import { wsUrl } from './env.js'
import { errorMessage } from './api.js'
import { mergeNowPlaying } from './nowPlaying.js'
import {
  botChannelIdAtom,
  connectionAtom,
  guildAtom,
  limitsAtom,
  nowPlayingAtom,
  soundsAtom,
  mySoundsAtom,
  toastAtom,
} from './state.js'

const PING_INTERVAL_MS = 25_000
const MAX_BACKOFF_MS = 10_000

/** @type {WebSocket | null} */
let current = null

/** サウンド再生をサーバーへリクエストする (可否の判定はサーバーが行う) */
export function requestPlay(soundId) {
  if (current?.readyState === WebSocket.OPEN) {
    current.send(JSON.stringify({ type: 'play', soundId }))
  }
}

/** 鳴っている音を1つ止める (id は nowPlaying の各要素の id) */
export function requestStop(id) {
  if (current?.readyState === WebSocket.OPEN) {
    current.send(JSON.stringify({ type: 'stop', id }))
  }
}

/** 鳴っている音を全部止める */
export function requestStopAll() {
  if (current?.readyState === WebSocket.OPEN) {
    current.send(JSON.stringify({ type: 'stopAll' }))
  }
}

/**
 * サーバーとのWS接続を維持する。切れたら指数バックオフで再接続し、再接続後は hello からやり直す。
 * @param {import('jotai').createStore extends (...args: any) => infer S ? S : never} store
 * @param {{ token: string, guildId: string, channelId: string, web?: boolean, onFirstReady: () => void, onFatal: (message: string) => void }} opts
 * @returns {() => void} 停止関数
 */
export function connectSocket(store, { token, guildId, channelId, web = false, onFirstReady, onFatal }) {
  let stopped = false
  let attempt = 0
  let retryTimer = null
  let pingTimer = null
  let firstReady = true

  const open = () => {
    if (stopped) return
    store.set(connectionAtom, 'connecting')
    const ws = new WebSocket(wsUrl())
    current = ws

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, guildId, channelId, ...(web ? { web: true } : {}) }))
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, PING_INTERVAL_MS)
    })

    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'ready':
          attempt = 0
          store.set(connectionAtom, 'open')
          store.set(limitsAtom, { maxUploadBytes: msg.limits?.maxUploadBytes ?? null })
          store.set(guildAtom, msg.guild ?? null)
          store.set(soundsAtom, msg.sounds)
          store.set(mySoundsAtom, msg.mine ?? [])
          store.set(botChannelIdAtom, msg.botChannelId)
          store.set(nowPlayingAtom, mergeNowPlaying(store.get(nowPlayingAtom), msg.nowPlaying, Date.now()))
          if (firstReady) {
            firstReady = false
            onFirstReady()
          }
          break
        case 'state':
          store.set(botChannelIdAtom, msg.botChannelId)
          store.set(nowPlayingAtom, mergeNowPlaying(store.get(nowPlayingAtom), msg.nowPlaying, Date.now()))
          break
        case 'sounds':
          store.set(soundsAtom, msg.sounds)
          store.set(mySoundsAtom, msg.mine ?? [])
          break
        case 'error':
          // 認証系は再接続しても直らないので致命扱い
          if (msg.code === 'not_guild_member' || msg.code === 'invalid_token') {
            stopped = true
            onFatal(errorMessage(msg.code))
          } else {
            store.set(toastAtom, { kind: 'error', text: errorMessage(msg.code) })
          }
          break
        default:
          break
      }
    })

    ws.addEventListener('close', () => {
      clearInterval(pingTimer)
      if (current === ws) current = null
      if (stopped) return
      store.set(connectionAtom, 'closed')
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt)
      attempt++
      retryTimer = setTimeout(open, delay)
    })
    ws.addEventListener('error', () => {
      // close イベントで再接続するのでここでは何もしない
    })
  }

  open()

  return () => {
    stopped = true
    clearTimeout(retryTimer)
    clearInterval(pingTimer)
    current?.close()
  }
}
