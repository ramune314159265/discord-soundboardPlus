import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { Client, GatewayIntentBits } from 'discord.js'
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice'
import { Mixer, OpusFrameEncoder } from './mixer.js'
import { OggOpusSource } from './oggOpusSource.js'

/** テストで差し替えられるよう、副作用のある関数だけ束ねておく */
export const realVoice = { createAudioPlayer, createAudioResource, entersState, joinVoiceChannel }

const CONNECT_TIMEOUT_MS = 20_000
/** 自分が送った退出に対する VOICE_STATE_UPDATE が届くまでの猶予 */
const OWN_LEAVE_ECHO_GRACE_MS = 5_000

export class BotError extends Error {
  constructor(code, message = code) {
    super(message)
    this.code = code
  }
}

/**
 * @typedef {object} Session
 * @property {import('@discordjs/voice').VoiceConnection} connection
 * @property {import('@discordjs/voice').AudioPlayer} player
 * @property {string} channelId       Discord が確認した、ボットが今いるチャンネル
 * @property {Mixer} mixer           鳴っている音の合成 (同時再生)
 * @property {AbortController} abort  破棄されたら中断される (待機中の join を即座に失敗させる)
 * @property {EventEmitter} events    'channel': channelId が確定/変更された
 * @property {ReturnType<typeof setTimeout> | null} leaveTimer
 */

/**
 * ボットのVC接続と再生を担当する。
 * 再生の可否はここで判定する = サーバー権威。音は重ねて同時に鳴らせる (上限は maxVoices)。
 *
 * 'state' イベント: (guildId) => void  (接続先 or 再生状態が変わった)
 *
 * サーバー側の他モジュールはこのクラスの公開メソッドだけに依存するので、
 * テストでは同じ形のフェイクに差し替えられる。
 */
export class VoiceBot extends EventEmitter {
  /**
   * @param {{
   *   client?: import('discord.js').Client,
   *   voice?: typeof realVoice,
   *   autoLeaveDelayMs?: number,
   *   maxVoices?: number,
   *   createMixer?: () => Mixer,
   *   createSource?: (data: Buffer) => import('./mixer.js').Source,
   * }} [options]
   *   autoLeaveDelayMs: 通話にボット以外の人間がいなくなってから退出するまでの猶予 (0 で即時)
   *   maxVoices: 同時に鳴らせる音の数
   */
  constructor({
    client,
    voice = realVoice,
    autoLeaveDelayMs = 5_000,
    maxVoices = 8,
    createMixer = () => new Mixer({ maxVoices, createEncoder: () => new OpusFrameEncoder() }),
    createSource = (data) => new OggOpusSource(data),
  } = {}) {
    super()
    this.voice = voice
    this.autoLeaveDelayMs = autoLeaveDelayMs
    this.createMixer = createMixer
    this.createSource = createSource
    this.client =
      client ?? new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] })
    /** @type {Map<string, Session>} */
    this.sessions = new Map()
    /**
     * 自分が送った退出に対して、遅れて届く VOICE_STATE_UPDATE を無視するための記録
     * @type {Map<string, { count: number, until: number }>}
     */
    this.expectedLeaves = new Map()

    this.client.on('voiceStateUpdate', (oldState, newState) => this.#onVoiceStateUpdate(oldState, newState))
    this.client.on('guildDelete', (guild) => {
      const session = this.sessions.get(guild.id)
      if (session) this.#teardown(guild.id, session, { sendLeave: false })
    })
    this.client.on('error', (err) => console.error('[bot] client error:', err))
  }

  async start(token) {
    await this.client.login(token)
    if (!this.client.isReady()) {
      await new Promise((resolve) => this.client.once('clientReady', resolve))
    }
    console.log(`[bot] logged in as ${this.client.user.tag}`)
  }

  async stop() {
    for (const [guildId, session] of this.sessions) this.#teardown(guildId, session)
    await this.client.destroy()
  }

  hasGuild(guildId) {
    return this.client.guilds.cache.has(guildId)
  }

  /**
   * nowPlaying: 今鳴っている音の一覧。同じサウンドを重ねていれば、その分だけ並ぶ。
   * @returns {{ botChannelId: string | null, nowPlaying: { id: string, soundId: string, userId: string }[] }}
   */
  getState(guildId) {
    const session = this.sessions.get(guildId)
    return {
      botChannelId: session?.channelId ?? null,
      nowPlaying: session ? session.mixer.list() : [],
    }
  }

  /**
   * ユーザーが今いる通話 (ボイスステートのキャッシュから)。いなければ null。
   * @returns {{ channelId: string, channelName: string } | null}
   */
  getUserVoice(guildId, userId) {
    const guild = this.client.guilds.cache.get(guildId)
    const channelId = guild?.voiceStates.cache.get(userId)?.channelId
    if (!guild || !channelId) return null
    return { channelId, channelName: guild.channels.cache.get(channelId)?.name ?? '' }
  }

  /** ボットを channelId に参加させる。すでに別チャンネルにいる場合は、接続を作り直さずそのまま移動する */
  async join(guildId, channelId) {
    const guild = this.client.guilds.cache.get(guildId)
    if (!guild) throw new BotError('bot_not_in_guild', 'ボットがこのサーバーに参加していません')

    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null))
    if (!channel || !channel.isVoiceBased()) throw new BotError('invalid_channel', '音声チャンネルではありません')

    const me = guild.members.me ?? (await guild.members.fetchMe())
    const perms = channel.permissionsFor(me)
    if (!perms?.has(['ViewChannel', 'Connect', 'Speak'])) {
      throw new BotError('no_permission', 'ボットにこのチャンネルへの接続/発言権限がありません')
    }

    let session = this.sessions.get(guildId)
    if (session && session.connection.state.status === VoiceConnectionStatus.Destroyed) {
      // 外部要因で壊れた残骸。退出は送らず作り直す
      this.#teardown(guildId, session, { sendLeave: false })
      session = undefined
    }

    const joinOptions = {
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // スピーカーミュートはしない (する必要がないので、解除したままにする)
      selfMute: false,
    }

    const isNew = !session
    if (!session) {
      session = this.#createSession(guildId, channelId, joinOptions)
    } else if (session.channelId !== channelId) {
      // 移動: 「退出 → 再参加」にすると、遅れて届く退出通知で新しい接続まで壊れるため、
      // 既存の接続に新しい参加ペイロードを送るだけにする (@discordjs/voice が同じ接続を返す)
      this.voice.joinVoiceChannel(joinOptions)
    }

    const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])
    try {
      await this.#waitForChannel(session, channelId, signal)
      await this.voice.entersState(session.connection, VoiceConnectionStatus.Ready, signal)
    } catch {
      if (session.abort.signal.aborted) {
        throw new BotError('disconnected', '参加の途中でボットが通話から切断されました')
      }
      // 新規参加が間に合わなかった場合のみ破棄。移動に失敗しただけなら元の接続は生かす
      if (isNew) this.#teardown(guildId, session)
      throw new BotError('connect_timeout', 'ボイスチャンネルへの接続がタイムアウトしました')
    }
    this.emit('state', guildId)
    this.#checkAlone(guildId)
  }

  leave(guildId) {
    const session = this.sessions.get(guildId)
    if (session) this.#teardown(guildId, session)
  }

  /**
   * 音を重ねて鳴らす。同じサウンドを再生中にもう一度押しても、そのまま重なる。
   * @returns {Promise<'ok' | 'busy' | 'not_in_channel' | 'not_ready' | 'unreadable' | 'invalid_sound'>}
   *   busy: 同時に鳴らせる数の上限 / unreadable: ファイルを読めない / invalid_sound: 音声として展開できない
   */
  async play(guildId, channelId, { filePath, soundId, userId }) {
    const session = this.sessions.get(guildId)
    const notReady = this.#playBlocker(guildId, session, channelId)
    if (notReady) return notReady
    if (session.mixer.isFull) return 'busy'

    let data
    try {
      data = await readFile(filePath)
    } catch {
      return 'unreadable'
    }
    // 読み込み中に退出・移動・切断が起きていないか、もう一度確かめる
    const blocker = this.#playBlocker(guildId, session, channelId)
    if (blocker) return blocker

    let source
    try {
      source = this.createSource(data)
    } catch (err) {
      console.error(`[bot] sound ${soundId} を展開できません:`, err.message)
      return 'invalid_sound'
    }
    if (session.mixer.add(source, { soundId, userId }) === null) {
      source.close()
      return 'busy'
    }
    return 'ok'
  }

  /**
   * 鳴っている音を止める。voiceId を省くと全部止める。
   * @returns {'ok' | 'not_in_channel' | 'not_found'}  not_found: その音はもう鳴っていない (自然に終わった等)
   */
  stop(guildId, channelId, voiceId) {
    const session = this.sessions.get(guildId)
    if (!session || session.channelId !== channelId) return 'not_in_channel'
    if (voiceId === undefined) {
      session.mixer.stopAll()
      return 'ok'
    }
    return session.mixer.stop(voiceId) ? 'ok' : 'not_found'
  }

  #playBlocker(guildId, session, channelId) {
    if (!session || this.sessions.get(guildId) !== session || session.channelId !== channelId) return 'not_in_channel'
    if (session.connection.state.status !== VoiceConnectionStatus.Ready) return 'not_ready'
    return null
  }

  // ------------------------------------------------------------------ 内部

  #createSession(guildId, channelId, joinOptions) {
    const connection = this.voice.joinVoiceChannel(joinOptions)
    const player = this.voice.createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    const mixer = this.createMixer()
    /** @type {Session} */
    const session = {
      connection,
      player,
      mixer,
      channelId,
      abort: new AbortController(),
      events: new EventEmitter(),
      leaveTimer: null,
    }
    this.sessions.set(guildId, session)

    connection.subscribe(player)

    connection.on('stateChange', async (_old, next) => {
      if (this.sessions.get(guildId) !== session) return
      if (next.status === VoiceConnectionStatus.Disconnected) {
        // 移動/再接続の可能性があるので少し待ち、戻らなければ破棄
        try {
          await Promise.race([
            this.voice.entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            this.voice.entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ])
        } catch {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy()
        }
      } else if (next.status === VoiceConnectionStatus.Destroyed) {
        this.#teardown(guildId, session, { sendLeave: false })
      }
    })

    // 音が無い状態から鳴らすとき、ミキサーが新しい出力ストリームを作る。それをそのまま再生する。
    // ミキサー自身が Opus にまで変換して渡す (prism-media 経由の opusscript エンコーダーは複数インスタンスで壊れるため使わない)
    mixer.on('stream', (stream) => {
      const inputType = mixer.outputType === 'opus' ? StreamType.Opus : StreamType.Raw
      player.play(this.voice.createAudioResource(stream, { inputType }))
    })
    mixer.on('change', () => this.emit('state', guildId))
    mixer.on('voiceError', (_id, err) => console.error(`[bot] guild ${guildId}: 音の展開に失敗しました:`, err.message))

    // プレイヤーが止まった/壊れたら、出力は途絶えているので、鳴っている途中の音も止める (表示だけ残らないように)
    player.on('stateChange', (_old, next) => {
      if (next.status === AudioPlayerStatus.Idle) mixer.stopAll()
    })
    player.on('error', (err) => {
      console.error(`[bot] player error (guild ${guildId}):`, err.message)
      mixer.stopAll()
    })
    return session
  }

  /** Discord が「ボットは channelId にいる」と通知するまで待つ */
  #waitForChannel(session, channelId, signal) {
    if (session.channelId === channelId) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        session.events.off('channel', onChannel)
        signal.removeEventListener('abort', onAbort)
      }
      const onChannel = () => {
        if (session.channelId === channelId) {
          cleanup()
          resolve()
        }
      }
      const onAbort = () => {
        cleanup()
        reject(new Error('aborted'))
      }
      session.events.on('channel', onChannel)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  #onVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild.id
    const session = this.sessions.get(guildId)
    const isBot = newState.id === this.client.user?.id

    if (isBot && !newState.channelId && this.#consumeExpectedLeave(guildId)) {
      // 自分が送った退出への通知。新しいセッションが既にあっても、それとは無関係なので無視する
      return
    }
    if (!session) return

    if (isBot) {
      if (!newState.channelId) {
        // 本当に切断された/キックされた (Discord 側は既に退出済みなので退出は送らない)
        this.#teardown(guildId, session, { sendLeave: false })
        return
      }
      if (newState.channelId !== session.channelId) {
        // 参加/移動が確定した、または管理者に移動させられた
        session.channelId = newState.channelId
        this.emit('state', guildId)
      }
      session.events.emit('channel')
      this.#checkAlone(guildId)
      return
    }

    // 他のメンバーの入退室: ボットのいるチャンネルに関係するときだけ確認する
    if (oldState.channelId === session.channelId || newState.channelId === session.channelId) {
      this.#checkAlone(guildId)
    }
  }

  // --- 自動退出 --------------------------------------------------------

  /** チャンネルにいる人間 (ボット以外) の数。プロフィール未取得のメンバーは人間として数える (誤退出を避ける) */
  #countHumans(guild, channelId) {
    let humans = 0
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId !== channelId) continue
      if (state.id === this.client.user?.id) continue
      if (state.member?.user?.bot === true) continue
      humans++
    }
    return humans
  }

  /** ボットしかいなくなったら、猶予のあとで退出する。誰かが戻ってきたら取り消す */
  #checkAlone(guildId) {
    const session = this.sessions.get(guildId)
    const guild = this.client.guilds.cache.get(guildId)
    if (!session || !guild) return

    if (this.#countHumans(guild, session.channelId) > 0) {
      clearTimeout(session.leaveTimer)
      session.leaveTimer = null
      return
    }
    if (session.leaveTimer) return

    const leaveIfStillAlone = () => {
      session.leaveTimer = null
      if (this.sessions.get(guildId) !== session) return
      if (this.#countHumans(guild, session.channelId) > 0) return
      console.log(`[bot] guild ${guildId}: 通話にボットしかいないため退出します`)
      this.#teardown(guildId, session)
    }
    if (this.autoLeaveDelayMs <= 0) {
      leaveIfStillAlone()
    } else {
      session.leaveTimer = setTimeout(leaveIfStillAlone, this.autoLeaveDelayMs)
      session.leaveTimer.unref?.()
    }
  }

  // --- 自分の退出通知の記録 ----------------------------------------------

  #expectLeave(guildId) {
    const now = Date.now()
    const entry = this.expectedLeaves.get(guildId)
    const count = (entry && entry.until > now ? entry.count : 0) + 1
    this.expectedLeaves.set(guildId, { count, until: now + OWN_LEAVE_ECHO_GRACE_MS })
  }

  #consumeExpectedLeave(guildId) {
    const entry = this.expectedLeaves.get(guildId)
    if (!entry) return false
    if (entry.until <= Date.now()) {
      this.expectedLeaves.delete(guildId)
      return false
    }
    entry.count--
    if (entry.count <= 0) this.expectedLeaves.delete(guildId)
    return true
  }

  /**
   * @param {{ sendLeave?: boolean }} [options] sendLeave: Discord に退出を送る (既に退出済みなら false)
   */
  #teardown(guildId, session, { sendLeave = true } = {}) {
    if (this.sessions.get(guildId) === session) this.sessions.delete(guildId)
    clearTimeout(session.leaveTimer)
    session.leaveTimer = null
    session.abort.abort() // 参加待ちの join を即座に失敗させる
    session.mixer.removeAllListeners()
    session.mixer.close()
    try {
      session.player.stop(true)
    } catch {
      /* noop */
    }
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        session.connection.destroy(sendLeave)
        if (sendLeave) this.#expectLeave(guildId)
      } catch {
        /* noop */
      }
    }
    this.emit('state', guildId)
  }
}
