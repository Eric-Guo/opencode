import { app, BrowserWindow, nativeImage, nativeTheme } from "electron"
import type { DesktopZoomLevel } from "@opencode/app/desktop-menu"
import type { Path } from "effect"
import { type TitlebarTheme } from "../../shared/ipc-contract"
import {
  WindowFocusChanged,
  WindowFullscreenChanged,
  WindowPinchZoomChanged,
  WindowZoomChanged,
} from "../../shared/ipc-rpc/events"
import { emitIpcEvent } from "../ipc-events"
import type { DesktopPaths } from "../paths"
import { BACKGROUND_COLOR_KEY, PINCH_ZOOM_ENABLED_KEY, ZOOM_LEVEL_KEY } from "../storage/keys"
import { getStore } from "../storage/store"
import { platformFrame, savedBackgroundColor, storedBackgroundColor, storedZoomLevel, titlebarOverlay, tone } from "./defaults"

import { getPrimaryWebContents } from "./content"

const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()

const controlColors = new WeakMap<BrowserWindow, string>()

const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()

const maxZoomLevel = 10

const minZoomLevel = 0.2

let backgroundColor: string | undefined

export function windowAppearance(path: Path.Path, paths: DesktopPaths.Resolved) {
  return {
    title: "SigmaAgents",
    icon: iconPath(path, paths),
    backgroundColor: backgroundColor ?? storedBackgroundColor(),
    ...platformFrame(tone(), storedZoomLevel()),
    webPreferences: {
      preload: paths.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

export function setDockIcon(path: Path.Path, paths: DesktopPaths.Resolved) {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(path.join(iconsDir(path, paths), "dock.png"))

  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function setBackgroundColor(color: string) {
  // The renderer reports its theme background on every boot; electron-store rewrites and fsyncs the
  // settings file on each set, so only persist a change.
  if (getBackgroundColor() !== color) getStore().set(BACKGROUND_COLOR_KEY, color)
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => {
    win.setBackgroundColor(color)

    if (process.platform === "darwin") win.invalidateShadow()
  })
}

export function getBackgroundColor() {
  return backgroundColor ?? savedBackgroundColor()
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)

  // Native window controls follow nativeTheme, not the renderer theme.
  if (process.platform === "darwin" || process.platform === "win32") {
    nativeTheme.themeSource = theme.scheme ?? theme.mode ?? "system"
  }

  updateTitlebar(win)
}

export function setTrafficLightsPosition(win: BrowserWindow, position: { x: number; y: number }) {
  if (process.platform !== "darwin") return
  win.setWindowButtonPosition({ x: Math.round(position.x), y: Math.round(position.y) })
}

export function setControlColor(win: BrowserWindow, color?: string) {
  if (color) controlColors.set(win, color)

  if (!color) controlColors.delete(win)
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  const options = overlay(titlebarThemes.get(win), getPrimaryWebContents(win).getZoomFactor())
  const color = controlColors.get(win)

  if (color !== undefined) options.symbolColor = color
  win.setTitleBarOverlay(options)
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  BrowserWindow.getAllWindows().forEach((win) => {
    pinchZoomEnabled.set(win, enabled)
    emitIpcEvent(getPrimaryWebContents(win), new WindowPinchZoomChanged({ enabled }))

    if (!enabled) getPrimaryWebContents(win).setZoomFactor(storedZoomLevel())
    updateZoom(win)
  })
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

// Saves the level and applies it to every window. A pinch zooms one window without saving.
export function setZoomLevel(level: DesktopZoomLevel) {
  if (storedZoomLevel() !== level) getStore().set(ZOOM_LEVEL_KEY, level)
  BrowserWindow.getAllWindows().forEach((win) => {
    getPrimaryWebContents(win).setZoomFactor(level)
    updateZoom(win)
  })
}

export function setZoomFactor(win: BrowserWindow, factor: number) {
  getPrimaryWebContents(win).setZoomFactor(clampZoom(factor))
  updateZoom(win)
}

export function wireZoom(win: BrowserWindow) {
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  getPrimaryWebContents(win).setZoomFactor(storedZoomLevel())
  updateTitlebar(win)
  getPrimaryWebContents(win).on("zoom-changed", (event, direction) => {
    event.preventDefault()

    if (pinchZoomEnabled.get(win)) {
      const delta = direction === "in" ? 0.2 : -0.2
      getPrimaryWebContents(win).setZoomFactor(clampZoom(getPrimaryWebContents(win).getZoomFactor() + delta))
      updateZoom(win)

      return
    }

    getPrimaryWebContents(win).setZoomFactor(storedZoomLevel())
    updateZoom(win)
  })
}

export function wireFullscreen(win: BrowserWindow) {
  const send = (fullscreen: boolean) => {
    if (win.isDestroyed() || getPrimaryWebContents(win).isDestroyed()) return
    emitIpcEvent(getPrimaryWebContents(win), new WindowFullscreenChanged({ fullscreen }))
  }

  win.on("enter-full-screen", () => send(true))
  win.on("leave-full-screen", () => send(false))
}

export function wireFocus(win: BrowserWindow) {
  const send = (focused: boolean) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    emitIpcEvent(win.webContents, new WindowFocusChanged({ focused }))
  }

  win.on("focus", () => send(true))
  win.on("blur", () => send(false))
}

function iconsDir(path: Path.Path, paths: DesktopPaths.Resolved) {
  return app.isPackaged ? path.join(process.resourcesPath, "icons") : path.join(paths.developmentResourcesRoot, "icons")
}

function iconPath(path: Path.Path, paths: DesktopPaths.Resolved) {
  return path.join(iconsDir(path, paths), `icon.${process.platform === "win32" ? "ico" : "png"}`)
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  return titlebarOverlay(theme.mode ?? tone(), zoom)
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  emitIpcEvent(
    getPrimaryWebContents(win),
    new WindowZoomChanged({ factor: getPrimaryWebContents(win).getZoomFactor(), level: storedZoomLevel() }),
  )
}
