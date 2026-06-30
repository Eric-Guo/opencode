import { BrowserWindow } from "electron"
import type { WebContents } from "electron"
import type { DesktopWindowExtension } from "../../extension"

import { recentNavigationHistory } from "./navigation-history"

const primary = new WeakMap<BrowserWindow, WebContents>()
const owners = new Map<number, BrowserWindow>()
const extensions = new WeakMap<BrowserWindow, DesktopWindowExtension>()
const renderers = new Set<WebContents>()
const listeners = new Set<(contents: WebContents) => void>()
const historyListeners = new Set<() => void>()

export function getPrimaryWebContents(win: BrowserWindow) {
  return primary.get(win) ?? win.webContents
}

export function getContentView(win: BrowserWindow) {
  return extensions.get(win)?.contentView ?? win.contentView
}

export function getActiveWebContents(win: BrowserWindow) {
  return extensions.get(win)?.active() ?? getPrimaryWebContents(win)
}

export function setWindowExtension(win: BrowserWindow, extension: DesktopWindowExtension) {
  extensions.set(win, extension)
  primary.set(win, extension.primary)
}

export function getWindowFromWebContents(contents: WebContents) {
  return BrowserWindow.fromWebContents(contents) ?? owners.get(contents.id) ?? null
}

export function trackWebContents(win: BrowserWindow, contents: WebContents, rpc = false) {
  owners.set(contents.id, win)
  contents.once("destroyed", () => {
    owners.delete(contents.id)
    renderers.delete(contents)
  })
  contents.on("did-navigate", notifyNavigationHistory)
  contents.on("did-navigate-in-page", notifyNavigationHistory)
  if (rpc) {
    renderers.add(contents)
    listeners.forEach((listener) => listener(contents))
  }
}

export function rendererContents() {
  return [...renderers]
}

export function subscribeWebContents(listener: (contents: WebContents) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyNavigationHistory() {
  historyListeners.forEach((listener) => listener())
}

export function subscribeNavigationHistory(listener: () => void) {
  historyListeners.add(listener)
  return () => historyListeners.delete(listener)
}

export function navigateWindow(win: BrowserWindow | null, direction: "back" | "forward") {
  if (!win) return
  const history = getActiveWebContents(win).navigationHistory
  if (direction === "back" && history.canGoBack()) history.goBack()
  if (direction === "forward" && history.canGoForward()) history.goForward()
}

export function reloadWindow(win: BrowserWindow | null) {
  if (win) getActiveWebContents(win).reload()
}

export function getNavigationHistory(win: BrowserWindow | null) {
  if (!win) return []
  const history = getActiveWebContents(win).navigationHistory
  return recentNavigationHistory(history.getAllEntries(), history.getActiveIndex())
}

export function goToNavigationHistory(win: BrowserWindow | null, index: number) {
  if (!win || !Number.isInteger(index)) return
  const history = getActiveWebContents(win).navigationHistory
  if (index < 0 || index >= history.length() || index === history.getActiveIndex()) return
  history.goToIndex(index)
}
