// ライト/ダークは、端末 (OS・ブラウザ) の設定に従う。設定が変わったら、開いたまま追従する。
// Chakra UI v3 は <html> の "dark" / "light" クラスでテーマを切り替える。

const QUERY = '(prefers-color-scheme: dark)'

/** @param {{ classList: { toggle(name: string, force: boolean): void }, style: { colorScheme: string } }} root */
export function applyColorMode(root, dark) {
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

/**
 * 端末の設定を今すぐ反映し、以後の変更にも追従する。matchMedia が無い環境ではライトのまま。
 * @returns {() => void} 追従をやめる関数
 */
export function followDeviceColorMode(win = window, root = win.document?.documentElement) {
  if (typeof win.matchMedia !== 'function') {
    applyColorMode(root, false)
    return () => {}
  }
  const media = win.matchMedia(QUERY)
  applyColorMode(root, media.matches)
  const onChange = (event) => applyColorMode(root, event.matches)
  media.addEventListener?.('change', onChange)
  return () => media.removeEventListener?.('change', onChange)
}
