// 複数の音源を1本のストリームに合成するミキサー (同時再生用)。
// 20ms ごとに 48kHz / ステレオ / s16le の PCM を作り、createEncoder があれば Opus パケットにして流す。

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { FRAME_SAMPLES } from './oggOpusSource.js'
import { OpusCodec } from './opusCodec.js'

export const FRAME_MS = 20
export const FRAME_BYTES = FRAME_SAMPLES * 2
/** 音が無くなってから、ストリームを終わらせるまで無音を流し続けるフレーム数 (この間に次の音が来れば途切れず繋がる) */
const IDLE_GRACE_FRAMES = 10
/** 出力を実時間より先に作っておく量 (フレーム数)。少ないほど押してから鳴るまでが速く、多いほど処理の揺れに強い */
const LEAD_FRAMES = 2
/** 処理が止まっていた後に、一気に作って取り戻す上限 */
const MAX_CATCHUP_MS = 100
/** 音の出だしのクリックを避けるフェードイン (サンプル数/チャンネル) = 約 2ms */
const FADE_IN_PAIRS = 96
/** 止めた音の切り口のクリックを避けるフェードアウト = 約 5ms */
const FADE_OUT_PAIRS = 240
const FRAME_PAIRS = FRAME_SAMPLES / 2
const INT16_MAX = 32_767

/**
 * 先読みリミッター。足した結果が int16 の範囲を超えるとき、音を切り捨てて歪ませる代わりに、
 * 超える「前から」ゲインを滑らかに下げ、超えたあとはゆっくり戻す。
 *
 * 1フレーム (20ms) 遅らせて出力することで、次のフレームのピークも見てからゲインを決められる。
 * 各フレームのゲインは「前フレーム終端のゲイン → このフレーム終端のゲイン」を直線で結ぶ。
 * 両端のゲインが、そのフレームのピークで決まる上限以下なので、途中のどのサンプルも天井を超えない。
 * 超えないときのゲインは常に 1 で、音は一切変わらない。
 */
export class LookaheadLimiter {
  #pending = new Float64Array(FRAME_SAMPLES) // 出力待ちのフレーム (最初は無音)
  #pendingLimit = 1 // #pending のピークから決まるゲインの上限
  #gain = 1

  /** @param {{ ceiling?: number, release?: number }} [options] release: 1フレームで、あと何割だけ 1 に戻すか */
  constructor({ ceiling = INT16_MAX, release = 0.12 } = {}) {
    this.ceiling = ceiling
    this.release = release
  }

  get gain() {
    return this.#gain
  }

  /**
   * 新しい生のフレームを渡すと、1つ前のフレームを (ゲイン調整して) 返す。
   * @param {ArrayLike<number>} raw 足し合わせただけの FRAME_SAMPLES 個
   * @returns {Int16Array}
   */
  process(raw) {
    let peak = 0
    for (let i = 0; i < FRAME_SAMPLES; i++) peak = Math.max(peak, Math.abs(raw[i]))
    const limit = peak > this.ceiling ? this.ceiling / peak : 1

    const target = Math.min(this.#pendingLimit, limit)
    const start = this.#gain
    const end = target < start ? target : Math.min(target, start + (1 - start) * this.release + 0.002)

    const out = new Int16Array(FRAME_SAMPLES)
    const pending = this.#pending
    for (let i = 0; i < FRAME_PAIRS; i++) {
      const g = start + ((end - start) * (i + 1)) / FRAME_PAIRS
      out[i * 2] = Math.max(-32_768, Math.min(INT16_MAX, Math.round(pending[i * 2] * g)))
      out[i * 2 + 1] = Math.max(-32_768, Math.min(INT16_MAX, Math.round(pending[i * 2 + 1] * g)))
    }
    this.#gain = end
    this.#pending = Float64Array.from(raw)
    this.#pendingLimit = limit
    return out
  }
}

/** 20ms の PCM フレームを1つの Opus パケットにするエンコーダー (ミキサーのストリームごとに1つ作る) */
export class OpusFrameEncoder {
  #codec = new OpusCodec({ channels: 2, sampleRate: 48_000, bitrate: 96_000 })
  encode(pcm) {
    return this.#codec.encode(pcm, FRAME_SAMPLES / 2)
  }
  delete() {
    this.#codec.delete()
  }
}

/**
 * @typedef {object} Source
 * @property {() => Int16Array | null} readFrame  次の20ms (FRAME_SAMPLES 個)。終わりなら null
 * @property {() => void} close
 * @property {number} [durationMs]  全体の長さ (分かれば)。再生位置の表示に使う
 */

/**
 * 'stream' (stream: Readable)  新しい出力ストリームを再生しはじめる必要があるとき (音が無い状態から鳴らすとき)
 * 'change' (voices)            鳴っている音の一覧が変わったとき
 * 'voiceError' (id, err)       ある音源の展開に失敗して、その音だけ止めたとき
 */
export class Mixer extends EventEmitter {
  /** @type {Map<string, { id: string, source: Source, meta: object }>} */
  #voices = new Map()
  #nextId = 1
  /** @type {MixerStream | null} */
  #stream = null
  #idleFrames = 0
  /** 止められて、フェードアウト中の音 (一覧には出ない) */
  #fading = []
  #limiter = new LookaheadLimiter()

  /**
   * @param {{
   *   maxVoices?: number,
   *   pacing?: boolean,
   *   now?: () => number,
   *   createEncoder?: (() => { encode(pcm: Buffer): Buffer, delete(): void }) | null,
   * }} [options]
   *   pacing: false にすると実時間に合わせず、読まれた分だけ即座に作る (テスト用)
   *   createEncoder: 指定すると、出力ストリームは PCM ではなく Opus パケット (1読み取り=1パケットのオブジェクトモード) になる
   */
  constructor({ maxVoices = 8, pacing = true, now = () => performance.now(), createEncoder = null } = {}) {
    super()
    this.maxVoices = maxVoices
    this.pacing = pacing
    this.now = now
    this.createEncoder = createEncoder
  }

  /** 出力ストリームの中身: 'opus' (パケット) または 'raw' (s16le の PCM) */
  get outputType() {
    return this.createEncoder ? 'opus' : 'raw'
  }

  get size() {
    return this.#voices.size
  }

  get isFull() {
    return this.#voices.size >= this.maxVoices
  }

  /** @returns {({ id: string } & Record<string, unknown>)[]} */
  list() {
    return [...this.#voices.values()].map((v) => ({
      id: v.id,
      ...v.meta,
      // 再生位置と長さ (ms)。表示側が、受け取った時刻からの経過で補間する
      positionMs: v.frames * FRAME_MS,
      durationMs: v.source.durationMs ?? null,
    }))
  }

  /**
   * 音を足す。同時に鳴らせる数を超えるときは追加せず null を返す (呼び出し側が source を閉じる)。
   * @param {Source} source
   * @param {object} [meta] list() にそのまま載る付加情報
   * @returns {string | null} 音ごとのID
   */
  add(source, meta = {}) {
    if (this.isFull) return null
    const id = String(this.#nextId++)
    this.#voices.set(id, { id, source, meta, frames: 0 })
    this.#idleFrames = 0
    if (!this.#stream || this.#stream.finished) {
      this.#limiter = new LookaheadLimiter()
      const stream = new MixerStream(this)
      this.#stream = stream
      stream.once('close', () => this.#onStreamClosed(stream))
      this.emit('stream', stream)
    }
    this.emit('change', this.list())
    return id
  }

  /** 音を止める。ぶつ切りのクリックを避けるため、次の20msの頭でフェードアウトしてから外す */
  stop(id) {
    const voice = this.#voices.get(id)
    if (!voice) return false
    this.#voices.delete(id)
    this.#release(voice)
    this.emit('change', this.list())
    return true
  }

  stopAll() {
    if (this.#voices.size === 0) return
    for (const voice of [...this.#voices.values()]) {
      this.#voices.delete(voice.id)
      this.#release(voice)
    }
    this.emit('change', this.list())
  }

  /** 全部すぐに止めて (フェード無し)、出力ストリームも閉じる */
  close() {
    const stream = this.#stream
    this.#stream = null
    stream?.destroy()
    for (const voice of [...this.#voices.values()]) this.#drop(voice)
    for (const voice of this.#fading.splice(0)) this.#close(voice)
    this.emit('change', this.list())
  }

  /**
   * 20ms 分を作る (MixerStream から呼ばれる)。音が無い状態がしばらく続いたら null (= ストリームを終わらせる)。
   * @returns {Buffer | null}
   */
  nextFrame() {
    const acc = new Float64Array(FRAME_SAMPLES)
    let contributed = 0
    let changed = false

    for (const voice of [...this.#voices.values()]) {
      let frame
      try {
        frame = voice.source.readFrame()
      } catch (err) {
        this.#drop(voice)
        this.emit('voiceError', voice.id, err)
        changed = true
        continue
      }
      if (!frame) {
        this.#drop(voice)
        changed = true
        continue
      }
      // 出だしだけ短くフェードインして、波形の途中から始まる音のクリックを避ける
      const fadeIn = voice.frames === 0 ? FADE_IN_PAIRS : 0
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const pair = i >> 1
        acc[i] += pair < fadeIn ? (frame[i] * pair) / fadeIn : frame[i]
      }
      voice.frames++
      contributed++
    }

    // 止められた音: このフレームの頭でフェードアウトして、外す
    for (const voice of this.#fading.splice(0)) {
      try {
        const frame = voice.source.readFrame()
        if (frame) {
          for (let i = 0; i < FRAME_SAMPLES; i++) {
            const pair = i >> 1
            if (pair < FADE_OUT_PAIRS) acc[i] += (frame[i] * (FADE_OUT_PAIRS - pair)) / FADE_OUT_PAIRS
          }
          contributed++
        }
      } catch {
        /* 止める音なので、読めなくても構わない */
      }
      this.#close(voice)
    }

    const frame = this.#limiter.process(acc)
    const out = Buffer.allocUnsafe(FRAME_BYTES)
    for (let i = 0; i < FRAME_SAMPLES; i++) out.writeInt16LE(frame[i], i * 2)

    if (changed) this.emit('change', this.list())

    if (this.#voices.size === 0 && contributed === 0) {
      if (++this.#idleFrames > IDLE_GRACE_FRAMES) return null
    } else {
      this.#idleFrames = 0
    }
    return out
  }

  /** 出力ストリームが生きていればフェードアウトさせ、無ければすぐ閉じる */
  #release(voice) {
    if (this.#stream && !this.#stream.finished) this.#fading.push(voice)
    else this.#close(voice)
  }

  #drop(voice) {
    this.#voices.delete(voice.id)
    this.#close(voice)
  }

  #close(voice) {
    try {
      voice.source.close()
    } catch {
      /* noop */
    }
  }

  /** 出力ストリームが外から閉じられた (プレイヤーの停止など)。鳴っている途中だった音は、もう出せないので止める */
  #onStreamClosed(stream) {
    if (this.#stream !== stream) return
    this.#stream = null
    this.stopAll()
    for (const voice of this.#fading.splice(0)) this.#close(voice)
  }
}

/** 実時間のペースで 20ms ずつ作って流す Readable。読まれていないときは作らない */
class MixerStream extends Readable {
  #mixer
  #encoder
  #timer = null
  #nextAt = null
  #finished = false

  constructor(mixer) {
    const encoder = mixer.createEncoder ? mixer.createEncoder() : null
    super(encoder ? { objectMode: true, highWaterMark: LEAD_FRAMES } : { highWaterMark: FRAME_BYTES * LEAD_FRAMES })
    this.#mixer = mixer
    this.#encoder = encoder
  }

  /** もう新しい音を受け付けない (終わった、または壊れた) */
  get finished() {
    return this.#finished || this.destroyed
  }

  _read() {
    this.#pump()
  }

  _destroy(err, callback) {
    clearTimeout(this.#timer)
    this.#timer = null
    this.#finished = true
    try {
      this.#encoder?.delete()
    } catch {
      /* noop */
    }
    this.#encoder = null
    callback(err)
  }

  #pump() {
    while (!this.#timer && !this.#finished && !this.destroyed) {
      if (this.#mixer.pacing) {
        const t = this.#mixer.now()
        this.#nextAt ??= t
        if (this.#nextAt < t - MAX_CATCHUP_MS) this.#nextAt = t - MAX_CATCHUP_MS
        const wait = this.#nextAt - LEAD_FRAMES * FRAME_MS - t
        if (wait > 0) {
          this.#timer = setTimeout(() => {
            this.#timer = null
            this.#pump()
          }, wait)
          return
        }
        this.#nextAt += FRAME_MS
      }

      const frame = this.#mixer.nextFrame()
      if (frame === null) {
        this.#finished = true
        this.push(null)
        return
      }
      let chunk = frame
      if (this.#encoder) {
        try {
          chunk = this.#encoder.encode(frame)
        } catch (err) {
          this.destroy(err)
          return
        }
      }
      if (!this.push(chunk)) return
    }
  }
}
