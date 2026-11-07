// VoiceBot を Discord/ボイスサーバー無しでテストするためのフェイク。
// 本物の @discordjs/voice の挙動のうち、今回のバグに関わる部分をそのまま真似ている:
//   - joinVoiceChannel(): 同じギルドの接続が生きていれば新規作成せず、それを返して参加ペイロードを送り直す
//   - destroy(): 退出ペイロード (channel_id: null) を送ってから Destroyed になる
//   - ゲートウェイ: ペイロードごとに少し遅れて VOICE_STATE_UPDATE を配信する (退出通知が遅れて届く状況を再現)

import { EventEmitter } from 'node:events'
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice'

const FRAME_BYTES = 960 * 2 * 2 // 20ms / 48kHz / ステレオ / s16

export const GUILD_ID = '1000000000000000001'
export const BOT_ID = '900'

class FakeConnection extends EventEmitter {
  constructor(joinConfig, adapterCreator, { neverReady }) {
    super()
    this.joinConfig = { ...joinConfig }
    this.state = { status: VoiceConnectionStatus.Signalling }
    this.destroyCount = 0
    this.adapter = adapterCreator({
      onVoiceStateUpdate: (data) => {
        if (data.channel_id) this.joinConfig.channelId = data.channel_id
      },
      onVoiceServerUpdate: () => {
        if (neverReady) return
        const { status } = this.state
        if (status !== VoiceConnectionStatus.Destroyed && status !== VoiceConnectionStatus.Ready) {
          this.setStatus(VoiceConnectionStatus.Ready)
        }
      },
      destroy() {},
    })
  }

  setStatus(status) {
    const old = this.state
    this.state = { ...old, status }
    this.emit('stateChange', old, this.state)
  }

  subscribe(player) {
    return { player }
  }

  destroy(adapterAvailable = true) {
    if (this.state.status === VoiceConnectionStatus.Destroyed) throw new Error('already destroyed')
    this.destroyCount++
    if (adapterAvailable) {
      this.adapter.sendPayload({ op: 4, d: { guild_id: this.joinConfig.guildId, channel_id: null } })
    }
    this.setStatus(VoiceConnectionStatus.Destroyed)
  }
}

/** 1フレーム (Opus なら1パケット) だけ読む。オブジェクトモードに読み取りサイズを渡すと上限が引き上げられてしまうので渡さない */
function readOne(stream) {
  if (!stream) return null
  return stream.readableObjectMode ? stream.read() : stream.read(FRAME_BYTES)
}

function createPlayer() {
  const player = new EventEmitter()
  player.state = { status: AudioPlayerStatus.Idle }
  /** play() に渡されたリソースを順に記録する (出力ストリームが何回作り直されたかを調べる用) */
  player.played = []
  player.resource = null
  const set = (status) => {
    const old = player.state
    if (old.status === status) return
    player.state = { status }
    player.emit('stateChange', old, player.state)
  }
  // 本物と同じ: 別のリソースを渡すと古いほうは捨てられ (Idle にはならない)、ストリームが終わると Idle になる
  player.play = (resource) => {
    const previous = player.resource
    player.resource = resource
    player.played.push(resource)
    if (previous && previous !== resource) previous.stream.destroy()
    set(AudioPlayerStatus.Playing)
    resource.stream.once('end', () => {
      if (player.resource === resource) {
        player.resource = null
        set(AudioPlayerStatus.Idle)
      }
    })
  }
  player.stop = () => {
    const resource = player.resource
    player.resource = null
    resource?.stream.destroy()
    set(AudioPlayerStatus.Idle)
  }
  /** テスト用: 出力ストリームから n フレーム (20ms) 読み進める。読まれた分だけミキサーが動く (pacing: false 前提) */
  player.pull = (frames = 1) => {
    const chunks = []
    for (let i = 0; i < frames; i++) {
      const chunk = readOne(player.resource?.stream)
      if (!chunk) break
      chunks.push(chunk)
    }
    return chunks
  }
  /** テスト用: 最後まで読み切る (音が全部終わり、ストリームが閉じるまで)。'end' は次のティックで届く */
  player.drain = () => {
    const chunks = []
    for (let guard = 0; guard < 100_000 && player.resource; guard++) {
      const chunk = readOne(player.resource.stream)
      if (!chunk) break
      chunks.push(chunk)
    }
    return chunks
  }
  player.finish = player.stop // テスト用: 外から止まった
  return player
}

/**
 * @param {{ gatewayDelayMs?: number, neverReady?: boolean, channels?: string[] }} [options]
 */
export function createFakeDiscord({ gatewayDelayMs = 4, neverReady = false, channels = ['C1', 'C2'] } = {}) {
  const client = new EventEmitter()
  client.user = { id: BOT_ID, tag: 'bot#0001' }
  client.isReady = () => true
  client.login = async () => 'token'
  client.destroy = async () => {}

  const voiceStates = new Map()
  const guild = {
    id: GUILD_ID,
    voiceStates: { cache: voiceStates },
    members: { me: { id: BOT_ID }, fetchMe: async () => ({ id: BOT_ID }) },
    channels: { cache: new Map(), fetch: async () => null },
  }
  for (const id of channels) {
    guild.channels.cache.set(id, { id, isVoiceBased: () => true, permissionsFor: () => ({ has: () => true }) })
  }
  client.guilds = { cache: new Map([[GUILD_ID, guild]]) }

  /** 状態を更新し、discord.js と同じ順 (キャッシュ更新 → イベント) で配信する */
  function setVoiceState(userId, channelId, { bot = false, cached = true, methods } = {}) {
    const old = voiceStates.get(userId)
    const next = { id: userId, guild, channelId, member: cached ? { user: { bot } } : null }
    voiceStates.set(userId, next)
    if (userId === BOT_ID) methods?.onVoiceStateUpdate?.({ channel_id: channelId, user_id: userId })
    client.emit('voiceStateUpdate', old ?? { id: userId, guild, channelId: null, member: next.member }, next)
  }

  guild.voiceAdapterCreator = (methods) => ({
    sendPayload(payload) {
      const channelId = payload.d.channel_id
      setTimeout(() => {
        setVoiceState(BOT_ID, channelId, { bot: true, methods })
        if (channelId) methods.onVoiceServerUpdate({ endpoint: 'voice.example' })
      }, gatewayDelayMs)
      return true
    },
    destroy() {},
  })

  const connections = new Map()
  const players = []
  const voice = {
    joinVoiceChannel(options) {
      const existing = connections.get(options.guildId)
      const payload = { op: 4, d: { guild_id: options.guildId, channel_id: options.channelId } }
      if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
        existing.adapter.sendPayload(payload) // 本物と同じ: 作り直さず既存接続に参加ペイロードを送る
        return existing
      }
      const connection = new FakeConnection(options, options.adapterCreator, { neverReady })
      connection.on('stateChange', (_old, next) => {
        if (next.status === VoiceConnectionStatus.Destroyed && connections.get(options.guildId) === connection) {
          connections.delete(options.guildId)
        }
      })
      connections.set(options.guildId, connection)
      connection.adapter.sendPayload(payload)
      return connection
    },
    createAudioPlayer() {
      const player = createPlayer()
      players.push(player)
      return player
    },
    createAudioResource(stream, options) {
      return { fake: true, stream, options }
    },
    entersState(target, status, timeoutOrSignal) {
      if (target.state.status === status) return Promise.resolve(target)
      // 数値の場合も本物同様にタイムアウト扱い (テストでイベントループが空にならないよう通常のタイマーを使う)
      let timer
      let signal = timeoutOrSignal
      if (typeof timeoutOrSignal === 'number') {
        const controller = new AbortController()
        timer = setTimeout(() => controller.abort(), timeoutOrSignal)
        signal = controller.signal
      }
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          target.off('stateChange', onChange)
          signal?.removeEventListener('abort', onAbort)
        }
        const onChange = (_old, next) => {
          if (next.status === status) {
            cleanup()
            resolve(target)
          }
        }
        const onAbort = () => {
          cleanup()
          reject(new Error('The operation was aborted'))
        }
        target.on('stateChange', onChange)
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort)
      })
    },
  }

  return {
    client,
    voice,
    guild,
    guildId: GUILD_ID,
    connection: () => connections.get(GUILD_ID),
    lastPlayer: () => players.at(-1),
    /** 他のユーザーの入退室 (channelId = null で退出) */
    setUser: (userId, channelId, options) => setVoiceState(userId, channelId, options),
    /** Discord 側の都合でボットが切断された (キック等) */
    kickBot: () => setVoiceState(BOT_ID, null, { bot: true }),
    /** 管理者がボットを別チャンネルへ手動で移動した */
    moveBotByAdmin: (channelId) => {
      const connection = connections.get(GUILD_ID)
      setVoiceState(BOT_ID, channelId, {
        bot: true,
        methods: connection && { onVoiceStateUpdate: (d) => (connection.joinConfig.channelId = d.channel_id) },
      })
    },
  }
}

export async function waitFor(predicate, { timeout = 1500, interval = 5 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
