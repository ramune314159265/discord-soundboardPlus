const params = new URLSearchParams(window.location.search)

/** Discord の iframe 内で動いているか (frame_id が付与される) */
export const isInDiscord = params.has('frame_id')

/** Activity では URL Mapping のため /.proxy を付けてサーバーにアクセスする */
export const proxyPrefix = isInDiscord ? '/.proxy' : ''

export const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID || ''

export function apiUrl(path) {
  return `${proxyPrefix}${path}`
}

export function wsUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}${proxyPrefix}/ws`
}
