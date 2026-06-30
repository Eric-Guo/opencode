import { BrowserWindow } from "electron"
import type { DesktopMenuAction } from "@opencode/app/desktop-menu"
import { getActiveWebContents, navigateWindow, reloadWindow, updateTitlebar } from "../windows"

export type DesktopMenuActionHandlers = Partial<{
  checkForUpdates: () => void
  installCli: () => void
  createWindow: () => void
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
    case "app.installCli":
      handlers.installCli?.()
      return
    case "app.relaunch":
      handlers.relaunch?.()
      return
    case "window.new":
      handlers.createWindow?.()
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
      reloadWindow(win)
      return
    case "history.back":
      navigateWindow(win, "back")
      return
    case "history.forward":
      navigateWindow(win, "forward")
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
  return getActiveWebContents(win)
}

function setZoom(win: BrowserWindow | null, value: number) {
  if (!win) return
  getActiveWebContents(win).setZoomFactor(Math.min(Math.max(value, 0.2), 10))
  updateTitlebar(win)
}
