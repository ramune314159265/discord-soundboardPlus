// 再生中の一覧の、画面用の計算 (DOM に依存しないので Node でテストできる)。
//
// サーバーは状態が変わるたびに、各音の「再生位置 (positionMs)」と「長さ (durationMs)」を送る。
// 画面は、受け取った時刻を基準に、実時間の経過で位置を補間してバーを動かす。
// 終了予定時刻 (endsAt) は、その音を初めて見たときに決めて、あとの更新では動かさない
// (更新のたびに数msずれて、終わる時刻が近い音の並びが入れ替わるのを避けるため)。

/**
 * @typedef {object} PlayingItem
 * @property {string} id
 * @property {string} soundId
 * @property {string} userId
 * @property {number | null} durationMs
 * @property {number | null} startedAt  この端末の時計での開始時刻 (ms)
 * @property {number | null} endsAt     この端末の時計での終了予定時刻 (ms)。長さが不明なら null
 */

/**
 * サーバーから届いた一覧を画面用に変換する。
 * @param {PlayingItem[]} previous いま持っている一覧
 * @param {{ id: string, soundId: string, userId: string, positionMs?: number, durationMs?: number | null }[]} incoming
 * @param {number} now 受信時刻 (ms)
 * @returns {PlayingItem[]}
 */
export function mergeNowPlaying(previous, incoming, now) {
  const known = new Map((previous ?? []).map((p) => [p.id, p]))
  return (incoming ?? []).map((voice) => {
    const existing = known.get(voice.id)
    // 同じ id でも別のサウンドなら、ボットが入り直して id が振り直された別の音なので、引き継がない
    if (existing && existing.startedAt !== undefined && existing.soundId === voice.soundId) {
      return { ...existing, soundId: voice.soundId, userId: voice.userId }
    }
    const durationMs = Number.isFinite(voice.durationMs) ? voice.durationMs : null
    const startedAt = now - (Number.isFinite(voice.positionMs) ? voice.positionMs : 0)
    return {
      id: voice.id,
      soundId: voice.soundId,
      userId: voice.userId,
      durationMs,
      startedAt,
      endsAt: durationMs === null ? null : startedAt + durationMs,
    }
  })
}

/**
 * 流し終わるのが後のものが先頭 (上) になる並び。長さが分からないものは、いつ終わるか分からないので一番上。
 * 同じ終了時刻なら、あとから鳴らしたものが上。元の配列は変えない。
 * @param {PlayingItem[]} items
 */
export function sortByEndLatestFirst(items) {
  const order = new Map(items.map((item, index) => [item.id, index]))
  const endOf = (item) => (item.endsAt === null || item.endsAt === undefined ? Infinity : item.endsAt)
  return [...items].sort((a, b) => {
    const ea = endOf(a)
    const eb = endOf(b)
    if (ea !== eb) return ea === Infinity ? -1 : eb === Infinity ? 1 : eb - ea
    return order.get(b.id) - order.get(a.id)
  })
}

/**
 * いまの進み具合。長さが分からなければ ratio は null。
 * @param {PlayingItem} item
 * @param {number} now
 * @returns {{ ratio: number | null, remainingMs: number | null }}
 */
export function progressOf(item, now) {
  if (!item.durationMs || item.startedAt === null || item.startedAt === undefined) return { ratio: null, remainingMs: null }
  const elapsed = Math.max(0, now - item.startedAt)
  return {
    ratio: Math.min(1, elapsed / item.durationMs),
    remainingMs: Math.max(0, item.durationMs - elapsed),
  }
}

/** 残り時間の表示: 1分未満は「0.8秒」、それ以上は「1:05」 */
export function formatRemaining(ms) {
  if (ms === null || ms === undefined) return ''
  if (ms < 60_000) return `${(Math.ceil(ms / 100) / 10).toFixed(1)}秒`
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
