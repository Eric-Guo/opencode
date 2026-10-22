import { randomUUID } from "node:crypto"
import { app, BrowserWindow, screen, WebContentsView } from "electron"
import { Effect, FileSystem, Path } from "effect"
import { openExternalURL } from "../files"
import { saveImageAs } from "../files/image"
import { scoped } from "../native/logging"
import { DesktopPaths } from "../paths"
import { DesktopStorage } from "../storage"
import { DesktopProxy } from "../network"
import { getStore } from "../storage/store"
import { WINDOW_IDS_KEY } from "../storage/keys"
import { windowDataFile } from "../../shared/ipc-transport"
import { isQuitting, type State } from "../lifecycle/machine"
import { windowArguments } from "./bootstrap"
import {
  getBackgroundColor,
  getPinchZoomEnabled,
  setBackgroundColor,
  setDockIcon,
  setPinchZoomEnabled,
  setTitlebar,
  setTrafficLightsPosition,
  setZoomLevel,
  updateTitlebar,
  windowAppearance,
  wireFocus,
  wireFullscreen,
  wireZoom,
} from "./appearance"
import { loadWebContents, registerRendererOrigin, registerRendererProtocol, setProtocolReporter } from "./protocol"
import { createWindowRegistry } from "./registry"
import { windowRecovery } from "./recovery"
import { createRendererLoader } from "./renderer-loading"
import { createPanel } from "./panel"
import { createRevealDriver } from "./reveal-machine"
import { restoreEarlyWindow, type EarlyWindow } from "./early"
import { manageWindowState, readWindowState, resolveWindowState, windowStateFile } from "./window-state"
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

const revealDrivers = new WeakMap<BrowserWindow, ReturnType<typeof createRevealDriver>>()

const displays = {
  all: () => screen.getAllDisplays().map((display) => display.bounds),
  primary: () => screen.getPrimaryDisplay().bounds,
  matching: (bounds: Electron.Rectangle) => screen.getDisplayMatching(bounds).bounds,
}

const registry = createWindowRegistry<BrowserWindow>({
  read: () => getStore().get(WINDOW_IDS_KEY),
  write: (ids) => getStore().set(WINDOW_IDS_KEY, ids),
})

const opened = new Set<(win: BrowserWindow, id: string) => void>()

export {
  getBackgroundColor,
  getPinchZoomEnabled,
  registerRendererProtocol,
  setProtocolReporter,
  setBackgroundColor,
  setDockIcon,
  setPinchZoomEnabled,
  setTitlebar,
  setTrafficLightsPosition,
  setZoomLevel,
  updateTitlebar,
}

export function getLastFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()

  if (focused) return focused
  const win = registry.lastFocused()

  if (!win || win.isDestroyed()) return null

  return win
}

export function getWindowByID(id: string) {
  const win = registry.get(id)

  if (!win || win.isDestroyed()) return null

  return win
}

/** The persistent id of an app window, or undefined for popups and other native windows. */
export function getWindowID(win: BrowserWindow) {
  // An open window's id stays in the persisted list until it closes.
  return registry.persisted().find((id) => registry.get(id) === win)
}

/** App windows that host the renderer, excluding popups and other native windows. */
export function getMainWindows() {
  return registry.list().filter((win) => !win.isDestroyed())
}

/** Runs for each app window as it registers, before its renderer loads. */
export function onMainWindow(listener: (win: BrowserWindow, id: string) => void) {
  opened.add(listener)

  return () => {
    opened.delete(listener)
  }
}

export function setWindowThemeReady(win: BrowserWindow) {
  revealDrivers.get(win)?.dispatch({ type: "theme.ready" })
}

export const mainWindows = Effect.fn("Window.make")(function* (input: {
  readonly appState: () => State
  readonly relaunch: () => void
  /** Windows logoff or shutdown. */
  readonly sessionEnding: () => void
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve(app.getAppPath())
  const storage = yield* DesktopStorage.Service
  const proxy = yield* DesktopProxy.Service
  const runFork = Effect.runForkWith(yield* Effect.context())
  const wireWindowRecovery = yield* windowRecovery

  // The entry module created and showed the first restored window on ready; it is adopted here,
  // before any renderer loads, so the user never waited for the layers to see a window.
  const restore = () =>
    restoreEarlyWindow({
      ids: registry.persisted(),
      fallbackId: randomUUID(),
      openExternal: (url) => runFork(openExternalURL(url)),
    }).map((step) => create(step.id, step.kind === "adopt" ? step.entry : undefined))

  const create = (id: string = randomUUID(), early?: EarlyWindow) => {
    const stateFile = path.join(app.getPath("userData"), windowStateFile(id))
    const state = early?.state ?? resolveWindowState(readWindowState(stateFile), { width: 1280, height: 800 }, displays)
    const appearance = windowAppearance(path, paths)

    const win =
      early?.win ??
      new BrowserWindow({
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        show: false,
        autoHideMenuBar: true,
        ...appearance,
        webPreferences: {
          ...appearance.webPreferences,
          additionalArguments: windowArguments(id),
        },
      })

    const openExternal = (url: string) => {
      runFork(openExternalURL(url))
    }

    const loads = createRendererLoader<Electron.WebContents>((error) => {
      runFork(Effect.logError("renderer load failed", { error }))
    })

    const wire = (contents: Electron.WebContents, name: string) => {
      trackWebContents(win, contents, true)
      allowRendererPermissions(contents)
      wireWindowRecovery(win, contents, name, {
        relaunch: input.relaunch,
        reveal: () => revealDrivers.get(win)?.dispatch({ type: "recovery.requested" }),
      })
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
            additionalArguments: windowArguments(id),
          },
        })

        wire(view.webContents, options.id)
        view.setBackgroundColor(appearance.backgroundColor)
        loads.add(view.webContents, async () => {
          await proxy.prepare(view.webContents.session)
          await loadWebContents(view.webContents, options.html, options)
        })

        return view
      },
      createPanel(options) {
        const view = createPanel(win, {
          rendererRoot: paths.rendererRoot,
          preloadRoot: paths.preloadRoot,
          preload: options.preload,
          backgroundColor: appearance.backgroundColor,
          openExternal,
        })

        loads.add(view.webContents, async () => {
          await proxy.prepare(view.webContents.session)
          await loadWebContents(view.webContents, options.html, { devURL: false })
        })

        return view
      },
      trackContents: (contents) => trackWebContents(win, contents),
      prepareNetwork: (contents) => proxy.prepare(contents.session),
      load: async (contents, html) => {
        await proxy.prepare(contents.session)
        await loadWebContents(contents, html)
      },
      saveImageAs,
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

    if (!shell && early?.loaded) {
      trackWebContents(win, win.webContents, true)
      wireWindowRecovery(win, win.webContents, id, {
        relaunch: input.relaunch,
        reveal: () => revealDrivers.get(win)?.dispatch({ type: "recovery.requested" }),
      })
    }

    if (!shell && !early?.loaded) wire(win.webContents, id)

    const loadPrimary =
      loads.primary(getPrimaryWebContents(win)) ?? (() => loadWebContents(getPrimaryWebContents(win), "index.html"))

    win.on("focus", notifyNavigationHistory)
    win.on("closed", () => shell?.dispose())

    if (!early) manageWindowState(win, stateFile, state, displays)
    register(win, id, () => shell?.forget?.())
    wireFullscreen(win)
    wireFocus(win)
    wireZoom(win)

    const focusForTests = () => {
      if (app.isPackaged || process.env.OPENCODE_TEST_ONBOARDING !== "1") return

      if (process.platform === "darwin") app.focus({ steal: true })
      win.focus()
    }

    const reveal = createRevealDriver({
      early: !!early,
      show: (reason) => {
        if (win.isDestroyed()) return
        win.show()
        focusForTests()
        runFork(Effect.logInfo("main window visible", reason === "ready" ? { window: id } : { window: id, reason }))
      },
    })

    revealDrivers.set(win, reveal)

    if (early) {
      focusForTests()
      runFork(Effect.logInfo("main window visible", { window: id, shownAt: early.shownAt }))
    }

    const contentReady = () => reveal.dispatch({ type: "content.ready" })

    win.once("ready-to-show", contentReady)

    if (process.platform === "linux") getPrimaryWebContents(win).once("did-finish-load", contentReady)
    win.once("closed", () => {
      reveal.dispatch({ type: "window.closed" })
      revealDrivers.delete(win)
    })

    if (shell || !early?.loaded)
      void loadPrimary()
        .catch((error) => runFork(Effect.logError("renderer load failed", { error })))
        .finally(contentReady)

    return win
  }

  const register = (win: BrowserWindow, id: string, forget: () => void) => {
    registry.register(id, win)
    win.on("focus", () => registry.focused(id))
    // Windows emits session-end, but not before-quit, during shutdown and logoff.
    win.on("session-end", input.sessionEnding)
    win.on("closed", () => {
      if (!registry.closed(id, isQuitting(input.appState()))) return
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
    opened.forEach((listener) => listener(win, id))
  }

  return { create, restore }
})
