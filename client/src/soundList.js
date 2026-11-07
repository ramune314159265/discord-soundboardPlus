// サウンド一覧の絞り込みとタグ入力に関する、DOM に依存しないロジック (Node でテストできる)。

/** サーバー (routes.js の sanitizeTags) と同じ上限 */
export const MAX_TAGS = 10
export const MAX_TAG_LENGTH = 20

/** 1つのタグ文字列を整える (制御文字除去・空白詰め・長さ制限)。空なら '' */
export function normalizeTag(text) {
  const cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [...cleaned].slice(0, MAX_TAG_LENGTH).join('')
}

/** タグを1つ足した配列を返す。空・重複(大文字小文字無視)・上限超えは足さない */
export function addTag(tags, text) {
  const tag = normalizeTag(text)
  if (!tag || tags.length >= MAX_TAGS) return tags
  const key = tag.toLowerCase()
  if (tags.some((t) => t.toLowerCase() === key)) return tags
  return [...tags, tag]
}

export function removeTag(tags, tag) {
  return tags.filter((t) => t !== tag)
}

/** 入力欄の文字列を、区切り(カンマ・読点・改行)で確定済みのタグと残りの入力に分ける */
export function splitTagInput(text) {
  const parts = String(text).split(/[,、，\n]/)
  const rest = parts.pop() ?? ''
  return { done: parts, rest }
}

/** 一覧にあるタグを、使われている数の多い順 (同数なら名前順) に */
export function collectTags(sounds) {
  const counts = new Map()
  for (const sound of sounds) {
    for (const tag of sound.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
    .map(([tag, count]) => ({ tag, count }))
}

/** 選んだタグを「すべて」持つサウンドだけ (AND)。何も選んでいなければそのまま */
export function filterByTags(sounds, selected) {
  if (selected.length === 0) return sounds
  return sounds.filter((s) => selected.every((tag) => (s.tags ?? []).includes(tag)))
}
