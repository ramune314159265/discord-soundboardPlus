import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const GUILD_ID_RE = /^\d{1,25}$/
const SOUND_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isGuildId(value) {
  return typeof value === 'string' && GUILD_ID_RE.test(value)
}

export function isSoundId(value) {
  return typeof value === 'string' && SOUND_ID_RE.test(value)
}

/**
 * サウンドのメタデータ (index.json) と音声ファイルを、サーバー(ギルド)ごとに分けずフラットに管理する。
 *
 *   <dataDir>/sounds/index.json
 *   <dataDir>/sounds/<soundId>.ogg
 *
 * 各サウンドは、追加されたギルド (guildId) と追加した人 (createdBy) を持つ。
 * 「このサーバーのサウンド」「自分が追加したサウンド」は、どちらもこの一覧からの絞り込み。
 *
 * - メモリ上にキャッシュし、変更時だけ書き戻す
 * - 書き込みは直列化し、tmp → rename で原子的に置き換える
 * - 以前の guilds/<guildId>/ 構成は読まない (移行しない)
 *
 * @typedef {{
 *   id: string, guildId: string | null, createdBy: string, name: string, emoji: string, tags: string[],
 *   file: string, size: number, durationMs: number, createdAt: number, updatedAt: number,
 * }} Sound
 */
export class SoundStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir
    /** @type {Promise<{version: number, sounds: Sound[]}> | null} */
    this.cache = null
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
  }

  get soundsDir() {
    return path.join(this.dataDir, 'sounds')
  }

  filePath(soundId) {
    if (!isSoundId(soundId)) throw new Error('invalid soundId')
    return path.join(this.soundsDir, `${soundId}.ogg`)
  }

  get #jsonPath() {
    return path.join(this.soundsDir, 'index.json')
  }

  #load() {
    if (!this.cache) {
      this.cache = this.#readFromDisk()
      this.cache.catch(() => {
        this.cache = null
      })
    }
    return this.cache
  }

  async #readFromDisk() {
    const file = this.#jsonPath
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 2, sounds: [] }
      throw err
    }
    try {
      const data = JSON.parse(text)
      if (!data || !Array.isArray(data.sounds)) throw new Error('unexpected shape')
      // 足りない項目は補う (手で編集された/古い形式でも読めるように)
      const sounds = data.sounds.map((s) => ({ tags: [], updatedAt: s.createdAt ?? 0, ...s }))
      return { version: 2, sounds }
    } catch (err) {
      // 壊れたJSONは退避して空から始める (起動不能にしない)
      const backup = `${file}.broken-${Date.now()}`
      await fs.rename(file, backup).catch(() => {})
      console.warn(`[store] index.json was unreadable (${err.message}); moved to ${backup}`)
      return { version: 2, sounds: [] }
    }
  }

  async #save(data) {
    const file = this.#jsonPath
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }

  /** 書き込みを直列化する */
  #enqueue(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  /** このサーバー(ギルド)に追加されたサウンド。古い順 */
  async listByGuild(guildId) {
    const data = await this.#load()
    return data.sounds.filter((s) => s.guildId === guildId).map(copy)
  }

  /** この人が追加したサウンド (どのサーバーのものも含む)。古い順 */
  async listByOwner(userId) {
    const data = await this.#load()
    return data.sounds.filter((s) => s.createdBy === userId).map(copy)
  }

  /** @returns {Promise<Sound | null>} */
  async get(soundId) {
    const data = await this.#load()
    const found = data.sounds.find((s) => s.id === soundId)
    return found ? copy(found) : null
  }

  /**
   * @param {{ guildId: string, createdBy: string, name: string, emoji: string, tags?: string[], data: Buffer, durationMs: number }} input
   * @returns {Promise<Sound>}
   */
  add(input) {
    // guildId が null のものは、どのサーバーにも属さない「自分だけのサウンド」
    if (input.guildId !== null && !isGuildId(input.guildId)) throw new Error('invalid guildId')
    return this.#enqueue(async () => {
      const data = await this.#load()
      const id = crypto.randomUUID()
      const file = this.filePath(id)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, input.data)

      const now = Date.now()
      const sound = {
        id,
        guildId: input.guildId,
        createdBy: input.createdBy,
        name: input.name,
        emoji: input.emoji,
        tags: input.tags ?? [],
        file: `${id}.ogg`,
        size: input.data.length,
        durationMs: input.durationMs,
        createdAt: now,
        updatedAt: now,
      }
      data.sounds.push(sound)
      try {
        await this.#save(data)
      } catch (err) {
        data.sounds.pop()
        await fs.unlink(file).catch(() => {})
        throw err
      }
      return copy(sound)
    })
  }

  /**
   * 名前・絵文字・タグを書き換える (渡した項目だけ)。
   * @param {string} soundId
   * @param {{ name?: string, emoji?: string, tags?: string[] }} patch
   * @returns {Promise<Sound | null>} 更新後。無ければ null
   */
  update(soundId, patch) {
    return this.#enqueue(async () => {
      const data = await this.#load()
      const sound = data.sounds.find((s) => s.id === soundId)
      if (!sound) return null
      const before = { ...sound, tags: [...sound.tags] }
      if (patch.name !== undefined) sound.name = patch.name
      if (patch.emoji !== undefined) sound.emoji = patch.emoji
      if (patch.tags !== undefined) sound.tags = [...patch.tags]
      sound.updatedAt = Date.now()
      try {
        await this.#save(data)
      } catch (err) {
        Object.assign(sound, before)
        throw err
      }
      return copy(sound)
    })
  }

  /** @returns {Promise<boolean>} 削除できたか */
  remove(soundId) {
    return this.#enqueue(async () => {
      const data = await this.#load()
      const index = data.sounds.findIndex((s) => s.id === soundId)
      if (index === -1) return false
      const [removed] = data.sounds.splice(index, 1)
      try {
        await this.#save(data)
      } catch (err) {
        data.sounds.splice(index, 0, removed)
        throw err
      }
      // JSONから消した後でファイルを消す。再生中のストリームは開いたままなので影響しない
      await fs.unlink(this.filePath(soundId)).catch(() => {})
      return true
    })
  }
}

function copy(sound) {
  return { ...sound, tags: [...(sound.tags ?? [])] }
}
