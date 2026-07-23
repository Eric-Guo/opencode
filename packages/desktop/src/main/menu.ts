import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import {
  DESKTOP_MENU_HISTORY_LIMIT,
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuHistoryEntry,
  type DesktopMenuRole,
} from "@opencode-ai/app/desktop-menu"

import { UPDATER_ENABLED } from "./constants"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { openExternalURL } from "./windows"
import { nativeT } from "./native-translations"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  relaunch: () => void
  getHistory: () => DesktopMenuHistoryEntry[]
  goToHistory: (index: number) => void
  onHistoryChange: (listener: () => void) => () => void
}

export function createMenu(deps: Deps) {
  if (process.platform !== "darwin") return

  const historyItems = Array.from({ length: DESKTOP_MENU_HISTORY_LIMIT }, (_, index) => ({
    id: `desktop-history-${index}`,
    label: "",
    visible: false,
    click: () => {
      const entry = deps.getHistory()[index]
      if (!entry || entry.active) return
      deps.goToHistory(entry.index)
    },
  }))
  const template = DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "macos")).map((menu) => {
    if (menu.role) return { role: nativeRole(menu.role), label: nativeT(menu.labelKey) }
    return {
      id: menu.id,
      label: nativeT(menu.labelKey),
      submenu: [
        ...(menu.items
          ?.filter((entry) => desktopMenuVisible(entry, "macos"))
          .map((entry) => nativeItem(entry, deps)) ?? []),
        ...(menu.id === "history"
          ? [{ id: "desktop-history-separator", type: "separator" as const, visible: false }, ...historyItems]
          : []),
      ],
    }
  })

  const applicationMenu = Menu.buildFromTemplate(template)
  const historyMenu = applicationMenu.items.find((item) => item.id === "history")?.submenu
  const updateHistory = () => {
    const history = deps.getHistory()
    const separator = historyMenu?.getMenuItemById("desktop-history-separator")
    if (separator) separator.visible = history.length > 0
    historyItems.forEach((_, index) => {
      const item = historyMenu?.getMenuItemById(`desktop-history-${index}`)
      if (!item) return
      const entry = history[index]
      item.label = entry?.url ?? ""
      item.visible = Boolean(entry)
      item.enabled = Boolean(entry && !entry.active)
    })
  }
  deps.onHistoryChange(updateHistory)
  updateHistory()
  Menu.setApplicationMenu(applicationMenu)
}

function nativeItem(entry: DesktopMenuEntry, deps: Deps): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  if (entry.role) return { role: nativeRole(entry.role), label: entry.labelKey ? nativeT(entry.labelKey) : undefined }

  const item: MenuItemConstructorOptions = {
    label: entry.labelKey ? nativeT(entry.labelKey) : undefined,
    accelerator: entry.accelerator?.macos,
    enabled: entry.enabled === "updater" ? UPDATER_ENABLED : undefined,
  }

  if (entry.command) {
    const command = entry.command
    item.click = () => deps.trigger(command)
  }
  if (entry.action) {
    const action = entry.action
    item.click = () =>
      runDesktopMenuAction(BrowserWindow.getFocusedWindow(), action, {
        checkForUpdates: deps.checkForUpdates,
        relaunch: deps.relaunch,
      })
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => openExternalURL(href)
  }

  return item
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}
