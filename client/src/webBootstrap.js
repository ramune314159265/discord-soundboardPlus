import { appStatusAtom, sessionAtom, toastAtom, webCallableAtom, webControlsAtom, webTargetsAtom, webUserAtom } from './state.js'

const POLL_MS = 5000

/** 鳴らせる通話の一覧が変わったか (同じ通話なら再接続しない) */
export function sameTarget(a, b) {
  return !!a && !!b && a.guildId === b.guildId && a.channelId === b.channelId
}

/**
 * 今つなぐ通話を決める。
 * 接続中の通話がまだ一覧にあればそのまま。なければ、1つだけなら自動で選び、複数なら選んでもらう (null)。
 */
export function pickTarget(targets, current, chosen = null) {
  if (chosen) return targets.find((t) => sameTarget(t, chosen)) ?? null
  if (current && targets.some((t) => sameTarget(t, current))) return current
  return targets.length === 1 ? targets[0] : null
}

/**
 * アクティビティ外のブラウザで動くときの起動処理。
 * Discordにログイン → 「ボットのいる通話に自分もいる」サーバーを探して接続し、5秒ごとに状況を確認する。
 * 通話から抜けたら接続を閉じて待機画面に戻り、また入れば自動でつなぎ直す。
 */
export async function startWeb(store, deps = {}) {
  // ブラウザ専用のモジュール (import.meta.env などに依存) は、必要になってから読み込む。テストでは差し替える
  const api = deps.fetchSession && deps.fetchTargets ? null : await import('./api.js')
  const poll = deps.poll ?? POLL_MS
  const fetchSession = deps.fetchSession ?? api.fetchWebSession
  const fetchTargets = deps.fetchTargets ?? api.fetchWebTargets
  const connect = deps.connect ?? (await import('./socket.js')).connectSocket
  const createApi = deps.createApi ?? api?.createApi ?? (await import('./api.js')).createApi
  const set = (value) => store.set(appStatusAtom, value)
  const session = await fetchSession()
  if (!session) return set({ status: 'login' })

  const token = session.access_token
  store.set(webUserAtom, session.user)

  let current = null // いま接続している通話
  let chosen = null // 複数から手動で選んだ通話
  let stop = null
  let timer = null
  let readyTimer = null
  let stopped = false

  const disconnect = () => {
    stop?.()
    stop = null
    clearTimeout(readyTimer)
    current = null
    store.set(sessionAtom, null)
  }

  const attach = (target) => {
    current = target
    store.set(sessionAtom, {
      api: createApi({ token, guildId: target.guildId }),
      guildId: target.guildId,
      channelId: target.channelId,
      user: session.user,
      web: true,
    })
    set({ status: 'loading', message: 'サーバーに接続中…' })
    stop = connect(store, {
      token,
      guildId: target.guildId,
      channelId: target.channelId,
      web: true,
      onFirstReady: () => {
        clearTimeout(readyTimer)
        set({ status: 'ready' })
      },
      onFatal: (message) => set({ status: 'error', message }),
    })
  }

  const tick = async () => {
    try {
      const { targets: all } = await fetchTargets(token)
      // 鳴らせるのは、ボットも同じ通話にいるもの。いないものは「ボットを呼ぶ」対象
      const targets = all.filter((t) => t.botHere !== false)
      store.set(webTargetsAtom, targets)
      store.set(webCallableAtom, all.filter((t) => t.botHere === false))
      if (current && !targets.some((t) => sameTarget(t, current))) disconnect() // 通話から抜けた/ボットがいなくなった
      const next = current ?? pickTarget(targets, null, chosen)
      if (!current && next) attach(next)
      else if (!current) {
        set(targets.length > 1 ? { status: 'choose' } : { status: 'waiting' })
      }
    } catch (err) {
      if (err?.status === 401) {
        disconnect()
        set({ status: 'login' })
        return // ログインし直すまで確認しない
      }
      // 一時的な失敗は次の確認で取り戻す
    }
    if (!stopped) timer = setTimeout(tick, poll)
  }

  // 画面から呼ぶ操作
  const controls = {
    /** 自分がいる通話にボットを呼ぶ。つながるのは次の確認 (すぐ実行する) で */
    async callBot(target) {
      try {
        await createApi({ token, guildId: target.guildId }).joinBot(target.channelId, { web: true })
      } catch (err) {
        store.set(toastAtom, { kind: 'error', text: err.message })
        return
      }
      clearTimeout(timer)
      await tick()
    },
    choose(target) {
      chosen = target
      disconnect()
      clearTimeout(timer)
      tick()
    },
  }
  store.set(webControlsAtom, controls)
  await tick()
  return {
    /** 確認と接続をやめる (テスト用) */
    stop() {
      clearTimeout(timer)
      stopped = true
      disconnect()
    },
  }
}
