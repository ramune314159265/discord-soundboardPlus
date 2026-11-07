// 複数ファイルの追加に関する、DOM に依存しないロジック (Node でテストできる)。

/** ファイル名から絵文字を取り出せないときの既定の絵文字 */
export const DEFAULT_EMOJI = '🎉'

/** サーバー (routes.js の sanitizeName) と同じ上限 (コードポイント数) */
export const MAX_NAME_LENGTH = 40

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// 絵文字1つ分の書記素: 絵文字(肌色・ZWJ結合・異体字セレクタ込み) / 国旗 / キーキャップ
const EMOJI_GRAPHEME = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)/u

export function splitGraphemes(text) {
  return Array.from(segmenter.segment(text), (s) => s.segment)
}

/** 入力欄用: 最後に入力された1書記素だけを残す (絵文字欄は常に1つだけ) */
export function lastGrapheme(text) {
  const graphemes = splitGraphemes(text)
  return graphemes.length > 0 ? graphemes[graphemes.length - 1] : ''
}

function isSingleEmoji(text) {
  const graphemes = splitGraphemes(text)
  return graphemes.length === 1 && EMOJI_GRAPHEME.test(graphemes[0])
}

/** 拡張子 (英数字1〜8文字) を取り除く。"Mr. Smith clip" のようなドット入りの名前は削らない */
export function stripExtension(fileName) {
  return fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '')
}

function normalizeName(text) {
  // 制御文字を除き、空白をまとめて、上限までに切り詰める (サーバーの処理に合わせる)
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join('')
}

/**
 * ファイル名から絵文字と名前の初期値を決める。
 *   "🎺_ぱふぱふ.mp3"  → 絵文字 🎺 / 名前 "ぱふぱふ"
 *   "ぱふぱふ.mp3"     → 絵文字 🎉 (既定) / 名前 "ぱふぱふ"
 * 最初の "_" で区切り、その前が絵文字1つだけのときに限って絵文字として扱う。
 * @param {string} fileName
 * @returns {{ emoji: string, name: string, matched: boolean }}
 */
export function parseSoundFileName(fileName) {
  const base = stripExtension(fileName).trim()
  const index = base.indexOf('_')
  if (index > 0) {
    const head = base.slice(0, index)
    const rest = normalizeName(base.slice(index + 1))
    if (rest && isSingleEmoji(head)) return { emoji: head, name: rest, matched: true }
  }
  return { emoji: DEFAULT_EMOJI, name: normalizeName(base) || normalizeName(fileName), matched: false }
}

let nextDraftId = 1

/**
 * 選択されたファイルから、入力欄の初期値つきの下書きを作る。
 * @param {Iterable<File>} files
 * @returns {{ id: string, file: File, emoji: string, name: string, tags: string[] }[]}
 */
export function createDrafts(files) {
  return Array.from(files, (file) => {
    const { emoji, name } = parseSoundFileName(file.name)
    return { id: `draft-${nextDraftId++}`, file, emoji, name, tags: [] }
  })
}

/**
 * 下書きを1つずつ「変換 → アップロード」する。あるファイルが失敗しても残りは続ける。
 * 並列にしないのは、デコードした PCM が大きいのでメモリを抑えるため。
 *
 * @param {{
 *   drafts: { id: string, file: File, name: string, emoji: string }[],
 *   convert: (file: File, options: { signal?: AbortSignal, onProgress?: (p: { phase: string, ratio: number }) => void }) => Promise<{ blob: Blob }>,
 *   upload: (input: { blob: Blob, name: string, emoji: string, tags: string[] }) => Promise<unknown>,
 *   onStatus?: (id: string, status: { state: 'converting' | 'uploading' | 'done' | 'error', phase?: string, ratio?: number, message?: string }) => void,
 *   signal?: AbortSignal,
 *   maxUploadBytes?: number | null,
 * }} options
 * @returns {Promise<{ succeeded: string[], failed: { id: string, message: string }[], aborted: boolean }>}
 */
export async function runBatch({ drafts, convert, upload, onStatus = () => {}, signal, maxUploadBytes = null }) {
  const succeeded = []
  const failed = []

  for (const draft of drafts) {
    if (signal?.aborted) return { succeeded, failed, aborted: true }
    try {
      onStatus(draft.id, { state: 'converting', phase: 'decoding', ratio: 0 })
      const { blob } = await convert(draft.file, {
        signal,
        onProgress: ({ phase, ratio }) => onStatus(draft.id, { state: 'converting', phase, ratio }),
      })
      if (signal?.aborted) return { succeeded, failed, aborted: true }

      if (maxUploadBytes && blob.size > maxUploadBytes) {
        throw new Error(
          `変換後のサイズが上限(${Math.floor(maxUploadBytes / 1024 / 1024)}MB)を超えています。短い音声にしてください`,
        )
      }
      onStatus(draft.id, { state: 'uploading' })
      await upload({ blob, name: draft.name.trim(), emoji: draft.emoji.trim(), tags: draft.tags ?? [] })
      onStatus(draft.id, { state: 'done' })
      succeeded.push(draft.id)
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) return { succeeded, failed, aborted: true }
      const message = err?.message || '追加に失敗しました'
      onStatus(draft.id, { state: 'error', message })
      failed.push({ id: draft.id, message })
    }
  }
  return { succeeded, failed, aborted: false }
}
