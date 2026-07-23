import { BrowserWindow } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import {
  createMainWindow,
  getPrimaryWebContents,
  navigateDesktopTab,
  reloadDesktopTab,
  updateTitlebar,
} from "./windows"

export type DesktopMenuActionHandlers = Partial<{
  checkForUpdates: () => void
  relaunch: () => void
}>

export function runDesktopMenuAction(
  win: BrowserWindow | null,
  action: DesktopMenuAction,
  handlers: DesktopMenuActionHandlers = {},
) {
  switch (action) {
    case "app.checkForUpdates":
      handlers.checkForUpdates?.()
      return
    case "app.relaunch":
      handlers.relaunch?.()
      return
    case "window.new":
      createMainWindow()
      return
    case "window.close":
      win?.close()
      return
    case "window.minimize":
      win?.minimize()
      return
    case "window.toggleMaximize":
      if (win?.isMaximized()) {
        win.unmaximize()
        return
      }
      win?.maximize()
      return
    case "view.reload":
      reloadDesktopTab(win)
      return
    case "history.back":
      navigateDesktopTab(win, "back")
      return
    case "history.forward":
      navigateDesktopTab(win, "forward")
      return
    case "view.toggleDevTools":
      getContents(win)?.toggleDevTools()
      return
    case "view.resetZoom":
      setZoom(win, 1)
      return
    case "view.zoomIn":
      setZoom(win, (getContents(win)?.getZoomFactor() ?? 1) + 0.2)
      return
    case "view.zoomOut":
      setZoom(win, (getContents(win)?.getZoomFactor() ?? 1) - 0.2)
      return
    case "view.toggleFullscreen":
      win?.setFullScreen(!win.isFullScreen())
      return
    case "edit.undo":
      getContents(win)?.undo()
      return
    case "edit.redo":
      getContents(win)?.redo()
      return
    case "edit.cut":
      getContents(win)?.cut()
      return
    case "edit.copy":
      getContents(win)?.copy()
      return
    case "edit.paste":
      getContents(win)?.paste()
      return
    case "edit.delete":
      getContents(win)?.delete()
      return
    case "edit.selectAll":
      getContents(win)?.selectAll()
      return
  }
}

function getContents(win: BrowserWindow | null) {
  if (!win) return
  return getPrimaryWebContents(win)
}

function setZoom(win: BrowserWindow | null, value: number) {
  if (!win) return
  getPrimaryWebContents(win).setZoomFactor(Math.min(Math.max(value, 0.2), 10))
  updateTitlebar(win)
}
