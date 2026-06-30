import { BrowserWindow } from "electron"
import type { WebContents } from "electron"

const primaryWebContents = new WeakMap<BrowserWindow, WebContents>()
const webContentsOwners = new Map<number, BrowserWindow>()

export function getPrimaryWebContents(win: BrowserWindow) {
  return primaryWebContents.get(win) ?? win.webContents
}

export function getWindowFromWebContents(contents: WebContents) {
  return BrowserWindow.fromWebContents(contents) ?? webContentsOwners.get(contents.id) ?? null
}

export function trackWebContents(win: BrowserWindow, contents: WebContents, primary = false) {
  if (primary) primaryWebContents.set(win, contents)
  webContentsOwners.set(contents.id, win)
  contents.once("destroyed", () => webContentsOwners.delete(contents.id))
}
