/**
 * Discord のアクティビティ表示モード (ACTIVITY_LAYOUT_MODE_UPDATE の layout_mode)。
 * @discord/embedded-app-sdk の Common.LayoutModeTypeObject と同じ値。
 *   - FOCUSED: 通常表示
 *   - PIP:     ウェブ版などで出る、小さなフローティングウィンドウ (操作するにはダブルクリックが必要)
 *   - GRID:    通話画面のタイル表示
 */
export const LAYOUT_MODE = Object.freeze({
  UNHANDLED: -1,
  FOCUSED: 0,
  PIP: 1,
  GRID: 2,
})
