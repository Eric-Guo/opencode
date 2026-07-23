import { DESKTOP_MENU_HISTORY_LIMIT, type DesktopMenuHistoryEntry } from "@opencode-ai/app/desktop-menu"
import type { NavigationEntry } from "electron"

export function recentDesktopTabHistory(entries: Pick<NavigationEntry, "url">[], activeIndex: number) {
  return entries
    .map((entry, index): DesktopMenuHistoryEntry => ({ index, url: entry.url, active: index === activeIndex }))
    .slice(-DESKTOP_MENU_HISTORY_LIMIT)
    .reverse()
}
