import windowState from "electron-window-state"
import { randomUUID } from "node:crypto"
import { app, BrowserWindow, WebContentsView } from "electron"
import { Effect, FileSystem, Path } from "effect"
import { openExternalURL } from "../files"
import { scoped } from "../native/logging"
import { DesktopPaths } from "../paths"
import { DesktopStorage } from "../storage"
import { getStore } from "../storage/store"
import { WINDOW_IDS_KEY } from "../storage/keys"
import { windowIDArgument } from "../../shared/window-bootstrap"
import {
  getBackgroundColor,
  getPinchZoomEnabled,
  setBackgroundColor,
  setDockIcon,
  setPinchZoomEnabled,
  setTitlebar,
  setZoomFactor,
  updateTitlebar,
  windowAppearance,
  wireFullscreen,
  wireZoom,
} from "./appearance"
import { loadWebContents, registerRendererOrigin, registerRendererProtocol } from "./protocol"
import { createWindowRegistry } from "./registry"
import { makeWindowRecovery } from "./recovery"
import { allowRendererPermissions, wireNavigationPolicy, wireRendererHeaders } from "./security"

import extension from "#desktop-main-extension"
import { emitIpcEvent } from "../ipc-events"
import { MenuCommandTriggered } from "../../shared/ipc-rpc/events"
import { getPrimaryWebContents, trackWebContents, setWindowExtension, notifyNavigationHistory } from "./content"
import { setControlColor } from "./appearance"
export {
  getPrimaryWebContents,
  getActiveWebContents,
  getWindowFromWebContents,
  subscribeWebContents,
  navigateWindow,
  reloadWindow,
  getNavigationHistory,
  goToNavigationHistory,
  subscribeNavigationHistory,
} from "./content"

const themeReady = new WeakMap<BrowserWindow, () => void>()
const registry = createWindowRegistry<BrowserWindow>({
  read: () => getStore().get(WINDOW_IDS_KEY),
  write: (ids) => getStore().set(WINDOW_IDS_KEY, ids),
})
let relaunchHandler = () => {
  setAppQuitting()
  app.relaunch()
  app.exit(0)
}

export {
  getBackgroundColor,
  getPinchZoomEnabled,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
  setPinchZoomEnabled,
  setTitlebar,
  setZoomFactor,
  updateTitlebar,
}

export function setRelaunchHandler(handler: () => void) {
  const previous = relaunchHandler
  relaunchHandler = handler
  return () => {
    if (relaunchHandler === handler) relaunchHandler = previous
  }
}

export function setAppQuitting(quitting = true) {
  registry.setQuitting(quitting)
}

export function getLastFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) return focused
  const win = registry.lastFocused()
  if (!win || win.isDestroyed()) return null
  return win
}

export function setWindowThemeReady(win: BrowserWindow) {
  themeReady.get(win)?.()
}

export const makeMainWindows = Effect.fn("Window.make")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve(app.getAppPath())
  const storage = yield* DesktopStorage.Service
  const runFork = Effect.runForkWith(yield* Effect.context())
  const wireWindowRecovery = yield* makeWindowRecovery

  const restore = () => {
    const ids = registry.persisted()
    return (ids.length ? ids : [randomUUID()]).map((id) => create(id))
  }

  const create = (id: string = randomUUID()) => {
    const state = windowState({ file: windowStateFile(id), defaultWidth: 1280, defaultHeight: 800 })
    const appearance = windowAppearance(path, paths)
    const win = new BrowserWindow({
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
      show: false,
      autoHideMenuBar: true,
      ...appearance,
      webPreferences: {
        ...appearance.webPreferences,
        additionalArguments: [windowIDArgument(id)],
      },
    })

    const openExternal = (url: string) => {
      runFork(openExternalURL(url))
    }
    const wire = (contents: Electron.WebContents, name: string) => {
      trackWebContents(win, contents, true)
      allowRendererPermissions(contents)
      wireWindowRecovery(win, contents, name, () => relaunchHandler())
      wireNavigationPolicy(contents, openExternal)
      wireRendererHeaders(contents)
    }
    const shell = extension.createWindow?.({
      window: win,
      id,
      preloadRoot: paths.preloadRoot,
      storage: storage.state,
      createRenderer(options) {
        registerRendererOrigin(options.devURL)
        const view = new WebContentsView({
          webPreferences: {
            ...appearance.webPreferences,
            additionalArguments: [windowIDArgument(id)],
          },
        })
        wire(view.webContents, options.id)
        view.setBackgroundColor(appearance.backgroundColor)
        // The primary renderer is loaded after reveal listeners and theme readiness are installed.
        if (options.id !== "opencode")
          void loadWebContents(view.webContents, options.html, options).catch((error) =>
            runFork(Effect.logError("renderer load failed", { error })),
          )
        return view
      },
      trackContents: (contents) => trackWebContents(win, contents),
      load: loadWebContents,
      openExternal,
      command: (id) => emitIpcEvent(getPrimaryWebContents(win), new MenuCommandTriggered({ id })),
      setControlColor: (color) => {
        setControlColor(win, color)
        notifyNavigationHistory()
      },
      log: (message, error) => {
        runFork(Effect.logError(message, { error }))
      },
    })
    if (shell) setWindowExtension(win, shell)
    if (!shell) wire(win.webContents, id)
    win.on("focus", notifyNavigationHistory)
    win.on("closed", () => shell?.dispose())
    state.manage(win)
    register(win, id, () => shell?.forget?.())
    wireFullscreen(win)
    wireZoom(win)
    let contentReady = false
    let appliedTheme = false
    let revealed = false
    const reveal = () => {
      if (!contentReady || !appliedTheme || revealed || win.isDestroyed()) return
      revealed = true
      win.show()
      runFork(Effect.logInfo("main window visible", { window: id }))
    }
    const ready = () => {
      contentReady = true
      reveal()
    }
    themeReady.set(win, () => {
      appliedTheme = true
      reveal()
    })
    win.once("ready-to-show", ready)
    if (process.platform === "linux") getPrimaryWebContents(win).once("did-finish-load", ready)
    win.once("closed", () => themeReady.delete(win))
    void loadWebContents(getPrimaryWebContents(win), "index.html")
      .catch((error) => runFork(Effect.logError("renderer load failed", { error })))
      .finally(ready)
    return win
  }

  const register = (win: BrowserWindow, id: string, forget: () => void) => {
    registry.register(id, win)
    win.on("focus", () => registry.focused(id))
    // Windows emits session-end, but not before-quit, during shutdown and logoff.
    win.on("session-end", () => registry.setQuitting())
    win.on("closed", () => {
      if (!registry.closed(id)) return
      forget()
      runFork(
        Effect.gen(function* () {
          yield* Effect.try(() => storage.state.clear(windowDataFile(id)))
          yield* fs.remove(path.join(app.getPath("userData"), windowStateFile(id)), { force: true })
        }).pipe(
          Effect.catch((error) => scoped("window", Effect.logError("failed to clean window state", { id, error }))),
        ),
      )
    })
  }

  return { create, restore }
})

function windowStateFile(id: string) {
  return `window-state-${safeWindowID(id)}.json`
}

// Mirrors windowStorage() in packages/app/src/runtime/persistence/storage.ts; it is the state
// namespace the renderer persists this window's tabs under.
function windowDataFile(id: string) {
  return `opencode.window.${safeWindowID(id)}.dat`
}

function safeWindowID(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-")
}
