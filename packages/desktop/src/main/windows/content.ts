import { BrowserWindow } from "electron"
import type { WebContents } from "electron"

const primaryWebContents = new WeakMap<BrowserWindow, WebContents>()
const webContentsOwners = new Map<number, BrowserWindow>()
const webContentsLocalAgents = new Map<number, string>()

export function getPrimaryWebContents(win: BrowserWindow) {
  return primaryWebContents.get(win) ?? win.webContents
}

export function getWindowFromWebContents(contents: WebContents) {
  return BrowserWindow.fromWebContents(contents) ?? webContentsOwners.get(contents.id) ?? null
}

export function trackWebContents(
  win: BrowserWindow,
  contents: WebContents,
  options: { primary?: boolean; localAgent?: string } = {},
) {
  if (options.primary) primaryWebContents.set(win, contents)
  webContentsOwners.set(contents.id, win)
  if (options.localAgent) webContentsLocalAgents.set(contents.id, options.localAgent)
  contents.once("destroyed", () => {
    webContentsOwners.delete(contents.id)
    webContentsLocalAgents.delete(contents.id)
  })
}

export function getLocalAgentFromWebContents(contents: WebContents) {
  return webContentsLocalAgents.get(contents.id)
}
