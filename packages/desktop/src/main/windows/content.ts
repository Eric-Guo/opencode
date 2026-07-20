import { BrowserWindow } from "electron"
import type { WebContents } from "electron"
import type { DesktopTabInitialization } from "../desktop-tabs"

const primaryWebContents = new WeakMap<BrowserWindow, WebContents>()
const webContentsOwners = new Map<number, BrowserWindow>()
const webContentsInitializations = new Map<number, DesktopTabInitialization>()

export function getPrimaryWebContents(win: BrowserWindow) {
  return primaryWebContents.get(win) ?? win.webContents
}

export function getWindowFromWebContents(contents: WebContents) {
  return BrowserWindow.fromWebContents(contents) ?? webContentsOwners.get(contents.id) ?? null
}

export function trackWebContents(
  win: BrowserWindow,
  contents: WebContents,
  options: { primary?: boolean; initialization?: DesktopTabInitialization } = {},
) {
  if (options.primary) primaryWebContents.set(win, contents)
  webContentsOwners.set(contents.id, win)
  if (options.initialization) webContentsInitializations.set(contents.id, options.initialization)
  contents.once("destroyed", () => {
    webContentsOwners.delete(contents.id)
    webContentsInitializations.delete(contents.id)
  })
}

export function getDesktopTabInitializationFromWebContents(contents: WebContents) {
  return webContentsInitializations.get(contents.id)
}
