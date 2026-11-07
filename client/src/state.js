import { atom } from 'jotai'
import { LAYOUT_MODE } from './layout.js'

/** { status: 'loading' | 'ready' | 'error', message?: string } */
export const appStatusAtom = atom({ status: 'loading', message: 'Discordに接続中…' })

/** { api, guildId, channelId, user: { id, username } } */
export const sessionAtom = atom(null)

/** このサーバーに追加されているサウンド */
export const soundsAtom = atom([])
/** 自分が追加したサウンド (他のサーバーで追加したものも含む) */
export const mySoundsAtom = atom([])
/** 表示中のタブ: 'guild' (このサーバー) | 'mine' (自分が追加) */
export const soundTabAtom = atom(/** @type {'guild' | 'mine'} */ ('guild'))
/** タグ絞り込みで選択中のタグ (すべてを含むものだけ表示) */
export const selectedTagsAtom = atom(/** @type {string[]} */ ([]))
/** 編集中のサウンドのID (なければ null) */
export const editingSoundIdAtom = atom(/** @type {string | null} */ (null))

/** 今のタブのサウンド (タグ絞り込み前) */
export const tabSoundsAtom = atom((get) => (get(soundTabAtom) === 'mine' ? get(mySoundsAtom) : get(soundsAtom)))
export const botChannelIdAtom = atom(/** @type {string | null} */ (null))
/** 今鳴っている音の一覧 (同じサウンドを重ねていれば、その分だけ並ぶ) */
export const nowPlayingAtom = atom(/** @type {import('./nowPlaying.js').PlayingItem[]} */ ([]))
/** 'connecting' | 'open' | 'closed' */
export const connectionAtom = atom('connecting')
export const limitsAtom = atom({ maxUploadBytes: null })
/** このアクティビティのギルド: { id, name, iconUrl } | null */
export const guildAtom = atom(/** @type {{ id: string, name: string, iconUrl: string | null } | null} */ (null))
/** Discord のレイアウトモード (LAYOUT_MODE) */
export const layoutModeAtom = atom(LAYOUT_MODE.UNHANDLED)
/** { kind: 'error' | 'info', text: string } | null */
export const toastAtom = atom(null)

/** ボットがこのアクティビティの通話にいるか */
export const botHereAtom = atom((get) => {
  const botChannelId = get(botChannelIdAtom)
  const session = get(sessionAtom)
  return botChannelId !== null && session !== null && botChannelId === session.channelId
})

const NO_SOUNDS = new Set()

/** この通話で鳴っているサウンドのID (ボタンを緑で囲う対象)。複数あり得る */
export const playingSoundIdsAtom = atom((get) =>
  get(botHereAtom) ? new Set(get(nowPlayingAtom).map((p) => p.soundId)) : NO_SOUNDS,
)

/** ミニフローティングウィンドウ(PiP)表示中か */
export const isPipAtom = atom((get) => get(layoutModeAtom) === LAYOUT_MODE.PIP)

/** ブラウザ(アクティビティ外)で、鳴らせる通話が複数あるときの選択肢と、いま選んでいるもの */
export const webTargetsAtom = atom(/** @type {{ guildId: string, name: string, iconUrl: string | null, channelId: string, channelName: string }[]} */ ([]))
/** 自分は通話に入っているが、ボットがいないサーバー (「ボットを呼ぶ」対象) */
export const webCallableAtom = atom(/** @type {{ guildId: string, name: string, channelId: string, channelName: string }[]} */ ([]))
export const webUserAtom = atom(/** @type {{ id: string, username: string } | null} */ (null))
/** ブラウザ版の画面から呼ぶ操作 ({ choose(target) }) */
export const webControlsAtom = atom(/** @type {{ choose: (target: any) => void, callBot: (target: any) => Promise<void> } | null} */ (null))
