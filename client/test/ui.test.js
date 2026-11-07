// 画面の描画テスト: Vite の SSR で実際のコンポーネントを読み込み、状態ごとの HTML を確認する。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
let server
let modules

before(async () => {
  // env.js が参照するブラウザ API の最小限のスタブ
  globalThis.window = { location: { search: '?frame_id=1', protocol: 'https:', host: 'x.discordsays.com' } }
  server = await createServer({
    root,
    cacheDir: path.join(os.tmpdir(), 'soundboard-vite-test-cache'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  const [chakra, jotai, app, state, layout, draftList] = await Promise.all([
    server.ssrLoadModule('@chakra-ui/react'),
    server.ssrLoadModule('jotai'),
    server.ssrLoadModule('/src/App.jsx'),
    server.ssrLoadModule('/src/state.js'),
    server.ssrLoadModule('/src/layout.js'),
    server.ssrLoadModule('/src/components/SoundDraftList.jsx'),
  ])
  modules = { chakra, jotai, App: app.default, S: state, LAYOUT_MODE: layout.LAYOUT_MODE, SoundDraftList: draftList.default }
})

after(async () => {
  await server?.close()
  delete globalThis.window
})

function render(setup) {
  const { chakra, jotai, App, S } = modules
  const store = jotai.createStore()
  setup(store, S)
  return renderToString(
    createElement(chakra.ChakraProvider, { value: chakra.defaultSystem }, createElement(jotai.Provider, { store }, createElement(App))),
  )
}

const text = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const ready = (store, S, { botChannelId = '10' } = {}) => {
  store.set(S.appStatusAtom, { status: 'ready' })
  store.set(S.sessionAtom, { channelId: '10', guildId: '1', api: {}, user: { id: '5' } })
  store.set(S.connectionAtom, 'open')
  store.set(S.botChannelIdAtom, botChannelId)
}

test('loading and error screens', () => {
  assert.match(text(render(() => {})), /Discordに接続中/)
  const error = render((store, S) => store.set(S.appStatusAtom, { status: 'error', message: 'テストエラー' }))
  assert.match(text(error), /起動できませんでした テストエラー/)
})

test('header: guild icon and name sit right next to the connection status', () => {
  const html = render((store, S) => {
    ready(store, S)
    store.set(S.guildAtom, { id: '1', name: 'おでん同好会', iconUrl: 'https://cdn.discordapp.com/icons/1/abc.png?size=64' })
  })
  assert.match(html, /<img[^>]+src="https:\/\/cdn\.discordapp\.com\/icons\/1\/abc\.png\?size=64"/)
  const t = text(html)
  const guildAt = t.indexOf('おでん同好会')
  const statusAt = t.indexOf('接続中')
  assert.ok(guildAt > t.indexOf('サウンドボード'), 'after the title')
  assert.ok(guildAt >= 0 && statusAt > guildAt, 'guild name comes immediately before the connection status')
  assert.ok(!t.slice(guildAt + 'おでん同好会'.length, statusAt).trim(), 'nothing between them')
})

test('header: a guild without an icon shows its initial', () => {
  const html = render((store, S) => {
    ready(store, S)
    store.set(S.guildAtom, { id: '1', name: 'zebra', iconUrl: null })
  })
  assert.ok(!/<img/.test(html))
  assert.match(text(html), /Z zebra/)
})

test('header: no guild info yet renders without crashing', () => {
  const html = render((store, S) => ready(store, S))
  assert.match(text(html), /サウンドボード/)
})

test('bot gate: join / move / leave', () => {
  assert.match(text(render((store, S) => ready(store, S, { botChannelId: null }))), /この通話にボットがいません .* ボットを通話に参加させる/)
  assert.match(text(render((store, S) => ready(store, S, { botChannelId: '99' }))), /別の通話に参加しています .* ボットをこの通話に移動/)
  assert.match(text(render((store, S) => ready(store, S))), /ボットがこの通話に参加しています/)
})

test('sound grid: every playing button is outlined in green (several at once), and only while the bot is in this call', () => {
  const sounds = [
    { id: 'a', name: 'ぱふぱふ', emoji: '🎺' },
    { id: 'b', name: 'ドラム', emoji: '' },
  ]
  const html = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    store.set(S.nowPlayingAtom, [{ id: '1', soundId: 'a', userId: '5' }])
  })
  assert.match(html, /aria-pressed="true"/)
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 1)

  // 同時に複数 / 同じサウンドを重ねたとき
  const both = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    store.set(S.nowPlayingAtom, [
      { id: '1', soundId: 'a', userId: '5' },
      { id: '2', soundId: 'b', userId: '6' },
      { id: '3', soundId: 'a', userId: '7' },
    ])
  })
  assert.equal((both.match(/aria-pressed="true"/g) ?? []).length, 2)
  assert.equal((both.match(/aria-pressed="false"/g) ?? []).length, 0)

  const elsewhere = render((store, S) => {
    ready(store, S, { botChannelId: '99' })
    store.set(S.soundsAtom, sounds)
    store.set(S.nowPlayingAtom, [{ id: '1', soundId: 'a', userId: '5' }])
  })
  assert.ok(!/aria-pressed/.test(elsewhere), 'no sound buttons when the bot is in another call')
})

test('now playing panel: lists every playing sound (layered ones too) with a stop button each, on the left of the grid', () => {
  const sounds = [
    { id: 'a', name: 'ぱふぱふ', emoji: '🎺' },
    { id: 'b', name: 'ドラム', emoji: '' },
  ]
  const html = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    store.set(S.nowPlayingAtom, [
      { id: '1', soundId: 'a', userId: '5' },
      { id: '2', soundId: 'b', userId: '6' },
      { id: '3', soundId: 'a', userId: '7' },
      { id: '4', soundId: 'gone', userId: '7' },
    ])
  })
  const t = text(html)
  assert.match(t, /再生中 4/)
  assert.equal((html.match(/を停止"/g) ?? []).length, 4, 'one stop button per playing sound')
  assert.match(html, /aria-label="ぱふぱふ を停止"/)
  assert.match(html, /aria-label="ドラム を停止"/)
  assert.match(t, /\(不明なサウンド\)/)
  const stopAll = html.match(/<button[^>]*>すべて停止<\/button>/)?.[0] ?? ''
  assert.ok(stopAll && !/disabled/.test(stopAll), 'stop-all is enabled while something plays')
  // 左側 = ボタン一覧より前に出る
  assert.ok(t.indexOf('再生中') < t.indexOf('この通話にボットがいません') || t.indexOf('再生中') < t.indexOf('音声を追加'))
  assert.ok(html.indexOf('再生中') < html.indexOf('aria-pressed'), 'the panel comes before the sound buttons')
})

test('now playing panel: a progress bar per sound, and the one that finishes last is listed first', () => {
  const sounds = [
    { id: 'a', name: 'みじかい', emoji: '🔔' },
    { id: 'b', name: 'ながい', emoji: '🎵' },
    { id: 'c', name: 'ふつう', emoji: '🥁' },
  ]
  const t0 = Date.now()
  const item = (id, soundId, duration, elapsed) => ({
    id,
    soundId,
    userId: '5',
    durationMs: duration,
    startedAt: t0 - elapsed,
    endsAt: t0 - elapsed + duration,
  })
  const html = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    // 並び順は「終わる時刻」の遅い順: ながい (あと 9 秒) → ふつう (あと 3 秒) → みじかい (あと 0.5 秒)
    store.set(S.nowPlayingAtom, [item('1', 'a', 1000, 500), item('2', 'b', 10_000, 1000), item('3', 'c', 4000, 1000)])
  })
  const t = text(html)
  const at = (name) => t.indexOf(name)
  assert.ok(at('ながい') < at('ふつう') && at('ふつう') < at('みじかい'), 'longest remaining on top')
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 3, 'one progress bar per playing sound')
  assert.match(html, /aria-label="ながい の再生位置"/)
  assert.match(t, /9\.\d秒/, 'remaining time of the longest one')
  // 進み具合: みじかい は半分 (500/1000)
  const bar = html.match(/<div[^>]*role="progressbar"[^>]*aria-label="みじかい の再生位置"[^>]*>/)?.[0] ?? ''
  assert.match(bar, /aria-valuenow="(4[5-9]|5[0-5])(\.\d)?"/, bar)
})

test('now playing panel: empty state, stop-all disabled, and hidden when the bot is not in this call', () => {
  const idle = render((store, S) => ready(store, S))
  assert.match(text(idle), /再生中の音声はありません/)
  assert.match(idle.match(/<button[^>]*>すべて停止<\/button>/)?.[0] ?? '', /disabled/)

  const elsewhere = render((store, S) => {
    ready(store, S, { botChannelId: '99' })
    store.set(S.nowPlayingAtom, [{ id: '1', soundId: 'a', userId: '5' }])
  })
  assert.ok(!/再生中/.test(text(elsewhere)), 'another call\'s sounds are never shown')
})

test('look: only Chakra UI defaults, with no hard-coded colors', async () => {
  const fs = await import('node:fs')
  const dir = path.join(root, 'src')
  const files = []
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))))
  walk(dir)
  for (const file of files.filter((f) => /\.(jsx?|css)$/.test(f))) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(fs.readFileSync(file, 'utf8')), `hard-coded color in ${path.relative(root, file)}`)
  }
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  assert.ok(!/class="dark"|class="light"|background:/.test(index), 'index.html does not hard-code a theme or background')
  assert.match(index, /prefers-color-scheme: dark/, 'the theme follows the device setting')
})

test('PiP: shows the double-click hint only in the mini floating window', () => {
  const hint = '操作するにはダブルクリックしてください'
  const pip = render((store, S) => {
    ready(store, S)
    store.set(S.layoutModeAtom, modules.LAYOUT_MODE.PIP)
  })
  assert.ok(text(pip).includes(hint))
  assert.match(pip, /pointer-events:\s*none/, 'the overlay must not swallow clicks or double-clicks')
  for (const mode of [modules.LAYOUT_MODE.FOCUSED, modules.LAYOUT_MODE.GRID, modules.LAYOUT_MODE.UNHANDLED]) {
    const other = render((store, S) => {
      ready(store, S)
      store.set(S.layoutModeAtom, mode)
    })
    assert.ok(!text(other).includes(hint), `no hint for layout mode ${mode}`)
  }
})

test('PiP: the hint also covers the loading and error screens', () => {
  const hint = '操作するにはダブルクリックしてください'
  assert.ok(text(render((store, S) => store.set(S.layoutModeAtom, modules.LAYOUT_MODE.PIP))).includes(hint))
  const error = render((store, S) => {
    store.set(S.appStatusAtom, { status: 'error', message: 'x' })
    store.set(S.layoutModeAtom, modules.LAYOUT_MODE.PIP)
  })
  assert.ok(text(error).includes(hint))
})

// ---- 複数ファイルの入力欄 (SoundDraftList) ----

function renderDrafts(props) {
  const { chakra, SoundDraftList } = modules
  return renderToString(
    createElement(
      chakra.ChakraProvider,
      { value: chakra.defaultSystem },
      createElement(SoundDraftList, { statuses: {}, onChange() {}, onRemove() {}, ...props }),
    ),
  )
}

const draftOf = (id, fileName, emoji, name) => ({ id, file: { name: fileName }, emoji, name })

test('draft list: every selected file gets its own emoji and name inputs, pre-filled', () => {
  const html = renderDrafts({
    drafts: [draftOf('a', '🎺_ぱふぱふ.mp3', '🎺', 'ぱふぱふ'), draftOf('b', 'ドラム.wav', '🎉', 'ドラム')],
  })
  assert.equal((html.match(/role="listitem"/g) ?? []).length, 2)
  for (const value of ['🎺', 'ぱふぱふ', '🎉', 'ドラム']) assert.ok(html.includes(`value="${value}"`), value)
  assert.ok(html.includes('aria-label="🎺_ぱふぱふ.mp3 の絵文字"'))
  assert.ok(html.includes('aria-label="ドラム.wav のサウンド名"'))
  assert.equal((html.match(/aria-invalid="true"/g) ?? []).length, 0)
  assert.ok(text(html).includes('🎺_ぱふぱふ.mp3') && text(html).includes('ドラム.wav'))
})

test('draft list: a row with an empty name is flagged', () => {
  const html = renderDrafts({ drafts: [draftOf('a', 'x.mp3', '🎉', ''), draftOf('b', 'y.mp3', '🎉', 'ok')] })
  assert.equal((html.match(/aria-invalid="true"/g) ?? []).length, 1)
})

test('draft list: per-file progress and results', () => {
  const html = renderDrafts({
    drafts: ['a', 'b', 'c', 'd', 'e'].map((id) => draftOf(id, `${id}.mp3`, '🎉', id)),
    statuses: {
      a: { state: 'converting', phase: 'decoding', ratio: 0 },
      b: { state: 'converting', phase: 'encoding', ratio: 0.456 },
      c: { state: 'uploading' },
      d: { state: 'done' },
      e: { state: 'error', message: 'この音声ファイルは読み込めませんでした' },
    },
  })
  const t = text(html)
  for (const expected of ['読み込み中…', '変換中 46%', 'アップロード中…', '✓ 追加しました', 'この音声ファイルは読み込めませんでした']) {
    assert.ok(t.includes(expected), expected)
  }
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1, 'only the failed file shows an alert')
})

test('draft list: inputs are disabled while uploading', () => {
  const drafts = [draftOf('a', 'a.mp3', '🎉', 'a')]
  // CSS の ":disabled" などと区別するため、タグの disabled 属性だけを数える
  const disabledTags = (html) => (html.match(/<[^>]*\sdisabled(?:="")?[^>]*>/g) ?? []).length
  assert.equal(disabledTags(renderDrafts({ drafts })), 0)
  assert.equal(disabledTags(renderDrafts({ drafts, disabled: true })), 4, '絵文字欄・名前欄・タグ欄・外すボタン')
})

test('sound grid: two tabs (this server / mine) with counts, showing the list for the selected tab', () => {
  const guild = [{ id: 'a', name: 'サーバーの音', emoji: '🎺', tags: [] }]
  const mine = [
    { id: 'b', name: '自分の音1', emoji: '🥁', tags: [] },
    { id: 'c', name: '自分の音2', emoji: '🔔', tags: [] },
  ]
  const html = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, guild)
    store.set(S.mySoundsAtom, mine)
  })
  const t = text(html)
  assert.match(t, /このサーバー \( ?1 ?\)/)
  assert.match(t, /自分が追加 \( ?2 ?\)/)
  assert.match(t, /サーバーの音/)
  assert.ok(!/自分の音1/.test(t), 'the other tab is not shown')

  const onMine = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, guild)
    store.set(S.mySoundsAtom, mine)
    store.set(S.soundTabAtom, 'mine')
  })
  assert.match(text(onMine), /自分の音1.*自分の音2/)
  assert.ok(!/サーバーの音/.test(text(onMine)))
  assert.match(text(render((store, S) => {
    ready(store, S)
    store.set(S.soundTabAtom, 'mine')
  })), /まだ自分が追加したサウンドがありません/)
})

test('sound grid: tag filter chips (by usage) narrow the list with AND, and every sound has an edit button', () => {
  const sounds = [
    { id: 'a', name: 'いち', emoji: '1', tags: ['ネタ', 'BGM'] },
    { id: 'b', name: 'に', emoji: '2', tags: ['ネタ'] },
    { id: 'c', name: 'さん', emoji: '3', tags: [] },
  ]
  const all = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
  })
  assert.equal((all.match(/data-tag-filter=/g) ?? []).length, 2)
  assert.ok(all.indexOf('data-tag-filter="ネタ"') < all.indexOf('data-tag-filter="BGM"'), 'most used first')
  assert.equal((all.match(/aria-pressed="false"/g) ?? []).length, 3 + 2, 'sound buttons + unselected chips')
  assert.match(all, /aria-label="いち を編集"/)
  assert.equal((all.match(/を編集"/g) ?? []).length, 3)

  const one = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    store.set(S.selectedTagsAtom, ['ネタ'])
  })
  assert.match(text(one), /いち/)
  assert.match(text(one), /に/)
  assert.ok(!/さん/.test(text(one)))
  assert.match(text(one), /絞り込みを解除/)

  const both = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    store.set(S.selectedTagsAtom, ['ネタ', 'BGM'])
  })
  assert.ok(/いち/.test(text(both)) && !/さん/.test(text(both)) && !/>に</.test(both))

  const none = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, [{ id: 'a', name: 'いち', emoji: '1', tags: ['x'] }])
    store.set(S.selectedTagsAtom, ['x', 'y'])
  })
  assert.match(text(none), /選んだタグをすべて持つサウンドはありません/)
})

test('edit panel: shows name, emoji and tags of the sound being edited', () => {
  const sounds = [{ id: 'a', name: 'ぱふぱふ', emoji: '🎺', tags: ['ネタ'] }]
  const html = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    store.set(S.editingSoundIdAtom, 'a')
  })
  assert.match(text(html), /サウンドを編集/)
  assert.match(html, /value="ぱふぱふ"/)
  assert.match(html, /value="🎺"/)
  assert.match(html, /aria-label="タグ ネタ を外す"/)
  assert.match(text(html), /保存/)
  // 編集中のサウンドが無くなっていたら何も出ない
  const gone = render((store, S) => {
    ready(store, S)
    store.set(S.soundsAtom, sounds)
    store.set(S.editingSoundIdAtom, 'zzz')
  })
  assert.ok(!/サウンドを編集/.test(text(gone)))
})

test('draft list: each file has its own tag input', () => {
  const html = renderDrafts({
    drafts: [{ id: 'd1', file: { name: 'a.mp3' }, emoji: '🎉', name: 'a', tags: ['ネタ'] }],
    statuses: {},
  })
  assert.match(html, /aria-label="a.mp3 のタグ"/)
  assert.match(html, /aria-label="タグ ネタ を外す"/)
})

test('browser mode screens: login button, waiting for the call, choosing a call', () => {
  const login = render((store, S) => store.set(S.appStatusAtom, { status: 'login' }))
  assert.match(text(login), /Discordでログイン/)
  assert.match(login, /href="\/auth\/login"/)

  assert.match(text(render((store, S) => store.set(S.appStatusAtom, { status: 'waiting' }))), /通話に参加すると/)
  const callable = render((store, S) => {
    store.set(S.appStatusAtom, { status: 'waiting' })
    store.set(S.webCallableAtom, [{ guildId: '1', channelId: '10', name: 'サーバーA', channelName: '雑談' }])
  })
  assert.match(text(callable), /ボットを通話に呼べます/)
  assert.match(text(callable), /サーバーA \/ 雑談 に呼ぶ/)

  const choose = render((store, S) => {
    store.set(S.appStatusAtom, { status: 'choose' })
    store.set(S.webTargetsAtom, [
      { guildId: '1', channelId: '10', name: 'サーバーA', channelName: '雑談', iconUrl: null },
      { guildId: '2', channelId: '20', name: 'サーバーB', channelName: 'ゲーム', iconUrl: null },
    ])
  })
  assert.match(text(choose), /サーバーA \/ 雑談.*サーバーB \/ ゲーム/)
})
