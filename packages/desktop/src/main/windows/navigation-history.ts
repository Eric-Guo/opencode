import { DESKTOP_MENU_HISTORY_LIMIT } from "@opencode/app/desktop-menu"

export function recentNavigationHistory(entries: { url: string }[], activeIndex: number) {
  return entries
    .map((entry, index) => ({ index, url: entry.url, active: index === activeIndex }))
    .slice(-DESKTOP_MENU_HISTORY_LIMIT)
    .reverse()
}
