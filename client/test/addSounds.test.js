import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EMOJI,
  MAX_NAME_LENGTH,
  createDrafts,
  lastGrapheme,
  parseSoundFileName,
  runBatch,
  stripExtension,
} from '../src/addSounds.js'

// ------------------------------------------------------------ ファイル名 → 絵文字と名前

test('"(絵文字)_(名前).(拡張子)" fills in the emoji and the name', () => {
  assert.deepEqual(parseSoundFileName('🎺_ぱふぱふ.mp3'), { emoji: '🎺', name: 'ぱふぱふ', matched: true })
  assert.deepEqual(parseSoundFileName('🔔_Ding Dong.wav'), { emoji: '🔔', name: 'Ding Dong', matched: true })
})

test('without the pattern, the emoji is 🎉 and the name is the file name without its extension', () => {
  assert.equal(DEFAULT_EMOJI, '🎉')
  assert.deepEqual(parseSoundFileName('ぱふぱふ.mp3'), { emoji: '🎉', name: 'ぱふぱふ', matched: false })
  assert.deepEqual(parseSoundFileName('drum'), { emoji: '🎉', name: 'drum', matched: false })
})

test('only the first underscore splits; the rest stays in the name', () => {
  assert.deepEqual(parseSoundFileName('🎺_foo_bar.mp3'), { emoji: '🎺', name: 'foo_bar', matched: true })
})

test('multi-codepoint emoji are recognized as one emoji (ZWJ, skin tone, flag, keycap, variation selector)', () => {
  for (const emoji of ['👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣', '❤️', '🏳️‍🌈']) {
    assert.deepEqual(parseSoundFileName(`${emoji}_name.ogg`), { emoji, name: 'name', matched: true }, emoji)
  }
})

test('a prefix that is not exactly one emoji is not treated as an emoji', () => {
  for (const file of ['abc_def.mp3', '1_one.mp3', '🎺🎻_two.mp3', '🎺 _spaced.mp3', 'あ_かな.mp3', '_lead.mp3']) {
    const result = parseSoundFileName(file)
    assert.equal(result.matched, false, file)
    assert.equal(result.emoji, DEFAULT_EMOJI, file)
    assert.equal(result.name, stripExtension(file).trim(), file)
  }
})

test('an emoji prefix with an empty name falls back to the whole file name', () => {
  assert.deepEqual(parseSoundFileName('🎺_.mp3'), { emoji: '🎉', name: '🎺_', matched: false })
  assert.deepEqual(parseSoundFileName('🎺_  .mp3'), { emoji: '🎉', name: '🎺_', matched: false })
})

test('extension handling: last extension only, and no false extensions', () => {
  assert.equal(parseSoundFileName('🎺_a.b.mp3').name, 'a.b')
  assert.equal(parseSoundFileName('🎺_Mr. Smith clip.mp3').name, 'Mr. Smith clip')
  assert.equal(parseSoundFileName('Mr. Smith clip').name, 'Mr. Smith clip') // ". Smith clip" は拡張子ではない
  assert.equal(parseSoundFileName('🎺_noext').name, 'noext')
  assert.equal(parseSoundFileName('.mp3').name, '.mp3') // 空になるときはファイル名そのもの
})

test('names are tidied like the server does: whitespace collapsed, control chars dropped, length capped', () => {
  assert.equal(parseSoundFileName('🎺_a   b.mp3').name, 'a b')
  assert.equal(parseSoundFileName('🎺_a\u0007b\tc.mp3').name, 'abc') // 制御文字(タブ含む)は、サーバーと同じく取り除く
  const long = 'あ'.repeat(100)
  const parsed = parseSoundFileName(`🎺_${long}.mp3`)
  assert.equal([...parsed.name].length, MAX_NAME_LENGTH)
  assert.equal(parseSoundFileName(`${long}.mp3`).name.length, MAX_NAME_LENGTH)
})

test('lastGrapheme keeps only the most recently typed emoji', () => {
  assert.equal(lastGrapheme(''), '')
  assert.equal(lastGrapheme('🎉'), '🎉')
  assert.equal(lastGrapheme('🎉🎺'), '🎺')
  assert.equal(lastGrapheme('🎉👨‍👩‍👧'), '👨‍👩‍👧')
})

test('createDrafts: one draft per file, with unique ids and auto-filled values', () => {
  const files = [{ name: '🎺_ぱふぱふ.mp3' }, { name: 'ドラム.wav' }]
  const drafts = createDrafts(files)
  assert.deepEqual(drafts.map(({ emoji, name }) => ({ emoji, name })), [
    { emoji: '🎺', name: 'ぱふぱふ' },
    { emoji: '🎉', name: 'ドラム' },
  ])
  assert.deepEqual(drafts.map((d) => d.tags), [[], []])
  assert.equal(drafts[0].file, files[0])
  assert.equal(new Set([...drafts, ...createDrafts(files)].map((d) => d.id)).size, 4)
})

// ------------------------------------------------------------ 一括処理

const blobOf = (size) => ({ size })
const draft = (id, name = id, emoji = '🎉') => ({ id, file: { name: `${id}.mp3` }, name, emoji })

function recorder() {
  const log = []
  return {
    log,
    onStatus: (id, status) => log.push([id, status.state]),
  }
}

test('runBatch: tags of each draft are uploaded with it', async () => {
  const uploads = []
  await runBatch({
    drafts: [{ ...draft('a'), tags: ['x', 'y'] }, draft('b')],
    convert: async () => ({ blob: blobOf(1) }),
    upload: async (input) => uploads.push(input.tags),
  })
  assert.deepEqual(uploads, [['x', 'y'], []])
})

test('runBatch: converts and uploads each file in order, with the trimmed name and emoji', async () => {
  const { log, onStatus } = recorder()
  const uploads = []
  const result = await runBatch({
    drafts: [draft('a', ' 名前A ', ' 🎺 '), draft('b', 'B', '')],
    convert: async () => ({ blob: blobOf(10) }),
    upload: async (input) => uploads.push(input),
    onStatus,
  })
  assert.deepEqual(result, { succeeded: ['a', 'b'], failed: [], aborted: false })
  assert.deepEqual(uploads.map(({ name, emoji }) => ({ name, emoji })), [
    { name: '名前A', emoji: '🎺' },
    { name: 'B', emoji: '' },
  ])
  // 1つ目が終わってから2つ目に進む (並列にしない)
  assert.deepEqual(log, [
    ['a', 'converting'], ['a', 'uploading'], ['a', 'done'],
    ['b', 'converting'], ['b', 'uploading'], ['b', 'done'],
  ])
})

test('runBatch: one file failing does not stop the others, and the error is reported for that file', async () => {
  const { log, onStatus } = recorder()
  const statuses = new Map()
  const uploaded = []
  const result = await runBatch({
    drafts: [draft('a'), draft('b'), draft('c')],
    convert: async (file) => {
      if (file.name === 'b.mp3') throw new Error('この音声ファイルは読み込めませんでした')
      return { blob: blobOf(10) }
    },
    upload: async ({ name }) => {
      if (name === 'c') throw new Error('サーバーエラー')
      uploaded.push(name)
    },
    onStatus: (id, status) => {
      onStatus(id, status)
      statuses.set(id, status)
    },
  })
  assert.deepEqual(result.succeeded, ['a'])
  assert.deepEqual(result.failed, [
    { id: 'b', message: 'この音声ファイルは読み込めませんでした' },
    { id: 'c', message: 'サーバーエラー' },
  ])
  assert.equal(result.aborted, false)
  assert.deepEqual(uploaded, ['a'])
  assert.equal(statuses.get('b').state, 'error')
  assert.equal(statuses.get('c').message, 'サーバーエラー')
  assert.ok(log.some(([id, state]) => id === 'c' && state === 'uploading'), 'c still reached the upload step')
})

test('runBatch: a converted file over the size limit is reported, not uploaded', async () => {
  const uploaded = []
  const result = await runBatch({
    drafts: [draft('big'), draft('small')],
    convert: async (file) => ({ blob: blobOf(file.name === 'big.mp3' ? 9 * 1024 * 1024 : 100) }),
    upload: async ({ name }) => uploaded.push(name),
    maxUploadBytes: 8 * 1024 * 1024,
  })
  assert.deepEqual(uploaded, ['small'])
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0].message, /上限\(8MB\)/)
})

test('runBatch: forwards conversion progress for the right file', async () => {
  const seen = []
  await runBatch({
    drafts: [draft('a')],
    convert: async (_file, { onProgress }) => {
      onProgress({ phase: 'encoding', ratio: 0.5 })
      return { blob: blobOf(1) }
    },
    upload: async () => {},
    onStatus: (id, status) => status.ratio !== undefined && seen.push([id, status.phase, status.ratio]),
  })
  assert.deepEqual(seen, [['a', 'decoding', 0], ['a', 'encoding', 0.5]])
})

test('runBatch: aborting stops before the next file and is not reported as a failure', async () => {
  const controller = new AbortController()
  const uploaded = []
  const result = await runBatch({
    drafts: [draft('a'), draft('b'), draft('c')],
    convert: async () => ({ blob: blobOf(1) }),
    upload: async ({ name }) => {
      uploaded.push(name)
      if (name === 'a') controller.abort() // 1つ目のアップロード中にキャンセル
    },
    signal: controller.signal,
  })
  assert.deepEqual(uploaded, ['a'], 'b and c are never started')
  assert.deepEqual(result, { succeeded: ['a'], failed: [], aborted: true })
})

test('runBatch: an AbortError thrown by the converter counts as an abort', async () => {
  const controller = new AbortController()
  const result = await runBatch({
    drafts: [draft('a'), draft('b')],
    convert: async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    },
    upload: async () => assert.fail('must not upload'),
    signal: controller.signal,
  })
  assert.deepEqual(result, { succeeded: [], failed: [], aborted: true })
})

test('runBatch: an empty list does nothing', async () => {
  assert.deepEqual(await runBatch({ drafts: [], convert: async () => assert.fail(), upload: async () => assert.fail() }), {
    succeeded: [],
    failed: [],
    aborted: false,
  })
})
