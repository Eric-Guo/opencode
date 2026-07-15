import windowState from "electron-window-state"
import contextMenu from "electron-context-menu"
import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import type { DesktopTheme } from "@opencode-ai/ui/theme/types"
import oc2ThemeJson from "../../../ui/src/theme/themes/oc-2.json"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron"
import type { Cookie, WebContents } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { loadDesktopTabs, type ExternalDesktopTab, type RendererDesktopTab } from "./desktop-tabs"
import { exportDebugLogs, write as writeLog } from "./logging"
import { getStore, removeStoreFile } from "./store"
import { DESKTOP_TAB_COOKIES_STORE, PINCH_ZOOM_ENABLED_KEY, WINDOW_IDS_KEY } from "./store-keys"
import { createUnresponsiveSampler } from "./unresponsive"
import { createWindowRegistry } from "./window-registry"
import { safeWebContentsURL } from "./window-state"

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const rendererProtocol = "oc"
const rendererHost = "renderer"
const clipboardWritePermission = "clipboard-sanitized-write"
const notificationPermission = "notifications"
const rendererPermissions = new Set([clipboardWritePermission, notificationPermission])
const oc2Theme = oc2ThemeJson as DesktopTheme
const oc2Background = {
  light: resolveThemeVariant(oc2Theme.light, false)["background-base"],
  dark: resolveThemeVariant(oc2Theme.dark, true)["background-base"],
}
const documentPolicyHeader = "Document-Policy"
const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"
type HeaderValue = string | string[]

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

let backgroundColor: string | undefined
let relaunchHandler = () => {
  setAppQuitting()
  app.relaunch()
  app.exit(0)
}
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const systemControlColors = new WeakMap<BrowserWindow, string>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const windowIDs = new WeakMap<BrowserWindow, string>()
const registry = createWindowRegistry<BrowserWindow>({
  read: () => getStore().get(WINDOW_IDS_KEY),
  write: (ids) => getStore().set(WINDOW_IDS_KEY, ids),
  cleanup: (id) => {
    rmSync(join(app.getPath("userData"), windowStateFile(id)), { force: true })
    removeStoreFile(windowDataFile(id))
    removeStoreFile(desktopTabStateFile(id))
  },
})
const primaryWebContents = new WeakMap<BrowserWindow, WebContents>()
const webContentsOwners = new Map<number, BrowserWindow>()
const titlebarHeight = 40
const tabbarWidth = 72
const maxZoomLevel = 10
const minZoomLevel = 0.2
const helpURL = "https://plm.thape.com.cn/projects/opencode/wiki/01-shi-yong-shuo-ming"
const desktopTabManagers = new Map<number, DesktopTabManager>()
const externalTabSessionRestores = new Map<string, Promise<void>>()

type DesktopTabID = string
type DesktopTabAction = "settings" | "help"
type DesktopTabManager = ReturnType<typeof createDesktopTabManager>
type DesktopTabsState = {
  active: DesktopTabID
  tabs: {
    id: DesktopTabID
    title: string
    label: string
  }[]
  navigation: {
    canGoBack: boolean
    canGoForward: boolean
  }
}

let desktopTabsIpcRegistered = false

export function getPrimaryWebContents(win: BrowserWindow) {
  return primaryWebContents.get(win) ?? win.webContents
}

export function getWindowFromWebContents(contents: WebContents) {
  return BrowserWindow.fromWebContents(contents) ?? webContentsOwners.get(contents.id) ?? null
}

function trackWebContents(win: BrowserWindow, contents: WebContents) {
  webContentsOwners.set(contents.id, win)
  contents.once("destroyed", () => {
    webContentsOwners.delete(contents.id)
  })
}

export function setRelaunchHandler(handler: () => void) {
  relaunchHandler = handler
}

export function setAppQuitting(quitting = true) {
  registry.setQuitting(quitting)
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => {
    win.setBackgroundColor(color)
    if (process.platform === "darwin") win.invalidateShadow()
  })
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function defaultBackgroundColor() {
  return oc2Background[tone()]
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1, systemControlColor?: string) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: systemControlColor ?? (mode === "dark" ? "white" : "black"),
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)
  // macOS draws the window frame hairline and shadow using the NSWindow
  // appearance, which follows nativeTheme rather than the rendered content.
  // Align it with the app theme so a light app on a dark system does not get
  // the dark-appearance border and shadow. A "system" scheme must map to
  // "system" (not the resolved mode) or prefers-color-scheme stops tracking
  // OS appearance changes in the renderer.
  if (process.platform === "darwin") nativeTheme.themeSource = theme.scheme ?? theme.mode ?? "system"
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(
    overlay(titlebarThemes.get(win), getPrimaryWebContents(win).getZoomFactor(), systemControlColors.get(win)),
  )
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  BrowserWindow.getAllWindows().forEach((win) => {
    const contents = getPrimaryWebContents(win)
    pinchZoomEnabled.set(win, enabled)
    contents.send("pinch-zoom-enabled-changed", enabled)
    if (!enabled && contents.getZoomFactor() !== 1) contents.setZoomFactor(1)
    updateZoom(win)
  })
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

export function getWindowID(win: BrowserWindow) {
  return windowIDs.get(win)
}

export function getLastFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) return focused
  const win = registry.lastFocused()
  if (!win || win.isDestroyed()) return null
  return win
}

export function restoreMainWindows() {
  const ids = registry.persisted()
  return (ids.length ? ids : [randomUUID()]).map((id) => createMainWindow(id))
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow(id: string = randomUUID()) {
  const desktopTabs = loadDesktopTabs()
  const state = windowState({
    file: windowStateFile(id),
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  const mode = tone()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    title: "SigmaAgents",
    icon: iconPath(),
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const openCodeView = createOpenCodeView(win)
  const tabbarView = createTabbarView(win)
  const tabManager = createDesktopTabManager(win, id, openCodeView, tabbarView, desktopTabs)

  allowRendererPermissions(openCodeView.webContents)
  wireWindowRecovery(win, openCodeView.webContents, "main")

  openCodeView.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const { requestHeaders } = details
    upsertKeyValue(requestHeaders, "Access-Control-Allow-Origin", ["*"])
    callback({ requestHeaders })
  })

  openCodeView.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders = {} } = details
    addRendererHeaders(details.url, responseHeaders)
    callback({ responseHeaders })
  })

  state.manage(win)
  registerWindow(win, id)
  wireFullscreen(win)
  wireZoom(win, openCodeView.webContents)
  tabManager.load()

  void loadWebContents(openCodeView.webContents, "index.html").finally(() => {
    if (!win.isDestroyed()) win.show()
  })

  return win
}

function registerWindow(win: BrowserWindow, id: string) {
  windowIDs.set(win, id)
  registry.register(id, win)

  win.on("focus", () => registry.focused(id))
  // Windows never emits before-quit on OS shutdown/logoff, but each window
  // gets session-end before it closes; flag the quit so ids stay persisted.
  win.on("session-end", () => registry.setQuitting())
  win.on("closed", () => registry.closed(id))
}

function windowStateFile(id: string) {
  return `window-state-${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
}

// Mirrors windowStorage() in packages/app/src/utils/persist.ts, which names
// the per-window renderer store this window persists its tabs into.
function windowDataFile(id: string) {
  return `opencode.window.${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.dat`
}

function desktopTabStateFile(id: string) {
  return `opencode.desktop-tabs.${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.dat`
}

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host !== rendererHost) {
      writeLog("protocol", "rejected host", { url: request.url }, "warn")
      return new Response("Not found", { status: 404 })
    }

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      writeLog("protocol", "rejected path", { url: request.url, file }, "warn")
      return new Response("Not found", { status: 404 })
    }

    try {
      const range = request.headers.get("range")
      const response = await net.fetch(pathToFileURL(file).toString(), {
        headers: range ? { range } : undefined,
      })
      if (response.status >= 400) {
        writeLog(
          "protocol",
          "fetch failed",
          {
            url: request.url,
            file,
            status: response.status,
            statusText: response.statusText,
          },
          "error",
        )
      }
      return addDocumentPolicy(response, file)
    } catch (error) {
      writeLog("protocol", "fetch error", { url: request.url, file, error }, "error")
      return new Response("Not found", { status: 404 })
    }
  })
}

function loadWebContents(
  contents: WebContents,
  html: string,
  options: { devUrl?: string | false; devHtml?: string } = {},
) {
  const devUrl = options.devUrl === false ? undefined : (options.devUrl ?? process.env.ELECTRON_RENDERER_URL)
  if (devUrl) {
    const url = new URL(options.devHtml ?? html, devUrl)
    return contents.loadURL(url.toString())
  }

  return contents.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

function createOpenCodeView(win: BrowserWindow) {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  primaryWebContents.set(win, view.webContents)
  trackWebContents(win, view.webContents)
  registerViewContextMenu(view)
  view.setBackgroundColor(backgroundColor ?? defaultBackgroundColor())
  win.contentView.addChildView(view)
  return view
}

function createTabbarView(win: BrowserWindow) {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(root, "../preload/tabbar.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trackWebContents(win, view.webContents)
  view.setBackgroundColor("#111315")
  win.contentView.addChildView(view)
  return view
}

function createDesktopTabManager(
  win: BrowserWindow,
  windowID: string,
  openCodeView: WebContentsView,
  tabbarView: WebContentsView,
  desktopTabs: ReturnType<typeof loadDesktopTabs>,
) {
  registerDesktopTabsIpc()
  const tabbarWebContents = tabbarView.webContents
  const tabbarWebContentsId = tabbarWebContents.id
  tabbarWebContents.once("destroyed", () => {
    desktopTabManagers.delete(tabbarWebContentsId)
  })

  let active: DesktopTabID = "opencode"
  const tabViews = new Map<DesktopTabID, WebContentsView>()

  function getView(id: DesktopTabID) {
    if (id === "opencode") return openCodeView
    return tabViews.get(id)
  }

  function getActiveView() {
    return getView(active) ?? openCodeView
  }

  function getTab(id: DesktopTabID) {
    return desktopTabs.find((tab) => tab.id === id)
  }

  function getExternalTab(id: DesktopTabID) {
    return desktopTabs.find(
      (tab): tab is ExternalDesktopTab => tab.id === id && "url" in tab,
    )
  }

  function getRendererTab(id: DesktopTabID) {
    return desktopTabs.find(
      (tab): tab is RendererDesktopTab => tab.id === id && "html" in tab,
    )
  }

  function ensureView(id: DesktopTabID) {
    if (id === "opencode") return openCodeView
    const cached = tabViews.get(id)
    if (cached) return cached
    const rendererTab = getRendererTab(id)
    if (rendererTab) {
      const view = createRendererTabView(win, rendererTab, sendState)
      tabViews.set(id, view)
      win.contentView.addChildView(view)
      view.setVisible(false)
      layout()
      return view
    }
    const tab = getExternalTab(id)
    if (!tab) return openCodeView
    const savedURL = getStore(desktopTabStateFile(windowID)).get(id)
    const url = typeof savedURL === "string" && isDesktopTabURL(tab, savedURL) ? savedURL : tab.url
    const view = createExternalView(
      win,
      tab,
      sendState,
      url,
      (url) => {
        if (isDesktopTabURL(tab, url)) getStore(desktopTabStateFile(windowID)).set(id, url)
      },
    )
    tabViews.set(id, view)
    win.contentView.addChildView(view)
    view.setVisible(false)
    layout()
    return view
  }

  function releaseView(id: DesktopTabID) {
    const tab = getTab(id)
    if (!tab || !("releaseWhenLostFocus" in tab) || !tab.releaseWhenLostFocus) return
    const view = tabViews.get(id)
    if (!view) return
    if ("url" in tab) {
      const url = view.webContents.getURL()
      if (isDesktopTabURL(tab, url)) getStore(desktopTabStateFile(windowID)).set(id, url)
    }
    tabViews.delete(id)
    win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
  }

  function state(): DesktopTabsState {
    const contents = getActiveView().webContents
    return {
      active,
      tabs: desktopTabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        label: tab.label,
      })),
      navigation: {
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      },
    }
  }

  function sendState() {
    if (tabbarWebContents.isDestroyed()) return
    tabbarWebContents.send("desktop-tabs-state", state())
  }

  function layout() {
    if (win.isDestroyed()) return
    const bounds = win.getContentBounds()
    const contentWidth = Math.max(0, bounds.width - tabbarWidth)
    tabbarView.setBounds({ x: 0, y: 0, width: tabbarWidth, height: bounds.height })
    openCodeView.setBounds({ x: tabbarWidth, y: 0, width: contentWidth, height: bounds.height })
    tabViews.forEach((view) => {
      view.setBounds({ x: tabbarWidth, y: 0, width: contentWidth, height: bounds.height })
    })
  }

  function activate(id: DesktopTabID) {
    const tab = getTab(id)
    if (!tab) return
    const previous = active
    active = id
    if (tab.systemControlColor) systemControlColors.set(win, tab.systemControlColor)
    if (!tab.systemControlColor) systemControlColors.delete(win)
    updateTitlebar(win)
    const activeView = ensureView(id)
    openCodeView.setVisible(id === "opencode")
    tabViews.forEach((view, viewID) => {
      view.setVisible(viewID === id)
    })
    if (previous !== id) releaseView(previous)
    win.contentView.addChildView(tabbarView)
    layout()
    sendState()
    activeView.webContents.focus()
  }

  function navigate(direction: "back" | "forward") {
    const contents = getActiveView().webContents
    if (direction === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    if (direction === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    sendState()
  }

  function runAction(action: DesktopTabAction) {
    if (action === "settings") {
      activate("opencode")
      openCodeView.webContents.send("menu-command", "settings.open")
      return
    }
    if (action === "help") {
      void shell.openExternal(helpURL)
    }
  }

  const managerValue = {
    load() {
      layout()
      openCodeView.webContents.on("did-navigate", sendState)
      openCodeView.webContents.on("did-navigate-in-page", sendState)
      openCodeView.webContents.on("did-stop-loading", sendState)
      void loadWebContents(tabbarWebContents, "tabbar.html").catch((error) => {
        writeLog("window", "tabbar load failed", { error }, "error")
      })
      sendState()
    },
    activate,
    back: () => navigate("back"),
    forward: () => navigate("forward"),
    reload: () => {
      getActiveView().webContents.reload()
    },
    action: runAction,
    sendState,
  }

  desktopTabManagers.set(tabbarWebContentsId, managerValue)
  win.on("resize", layout)
  win.on("closed", () => {
    desktopTabManagers.delete(tabbarWebContentsId)
  })
  return managerValue
}

function createRendererTabView(
  win: BrowserWindow,
  tab: RendererDesktopTab,
  sendState: () => void,
) {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trackWebContents(win, view.webContents)
  registerViewContextMenu(view)
  allowRendererPermissions(view.webContents)
  wireWindowRecovery(win, view.webContents, tab.id)
  view.setBackgroundColor(backgroundColor ?? defaultBackgroundColor())
  view.webContents.on("did-navigate", sendState)
  view.webContents.on("did-navigate-in-page", sendState)
  view.webContents.on("did-stop-loading", sendState)
  void loadWebContents(view.webContents, tab.html, {
    devUrl: process.env.ELECTRON_7777_RENDERER_URL ?? false,
    devHtml: tab.devHtml,
  }).catch((error) => {
    writeLog("window", "renderer tab initial load failed", { tab: tab.id, error }, "error")
  })
  return view
}

function createExternalView(
  win: BrowserWindow,
  tab: ExternalDesktopTab,
  sendState: () => void,
  url: string,
  saveURL: (url: string) => void,
) {
  const view = new WebContentsView({
    webPreferences: {
      partition: tab.partition,
      ...(tab.localServer ? { preload: join(root, "../preload/external-tab.js") } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trackWebContents(win, view.webContents)
  registerViewContextMenu(view)
  view.setBackgroundColor("#ffffff")
  view.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      Boolean(
        tab.localServer &&
          webContents === view.webContents &&
          isExternalTabPermission(permission) &&
          isDesktopTabURL(tab, details.requestingUrl),
      ),
    )
  })
  view.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    Boolean(
      tab.localServer &&
        webContents === view.webContents &&
        isExternalTabPermission(permission) &&
        isDesktopTabURL(tab, requestingOrigin),
    ),
  )
  view.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: "deny" }
  })
  view.webContents.on("will-navigate", (event, url) => {
    if (isDesktopTabURL(tab, url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  view.webContents.on("did-navigate", (_event, url) => {
    saveURL(url)
    sendState()
  })
  view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) saveURL(url)
    sendState()
  })
  view.webContents.on("did-stop-loading", sendState)
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    writeLog(
      "window",
      "external tab load failed",
      { tab: tab.id, errorCode, errorDescription, validatedURL },
      "error",
    )
  })
  void restoreExternalTabSession(tab)
    .then(() => view.webContents.loadURL(url))
    .catch((error) => {
      writeLog("window", "external tab initial load failed", { tab: tab.id, error }, "error")
    })
  return view
}

function isDesktopTabURL(tab: ExternalDesktopTab, url: string) {
  if (!URL.canParse(url)) return false
  if (tab.localServer) return new URL(url).origin === new URL(tab.url).origin
  return new URL(url).hostname === new URL(tab.url).hostname
}

function isExternalTabPermission(permission: string) {
  return (
    permission === clipboardWritePermission ||
    ["local-network-access", "local-network", "loopback-network"].includes(permission)
  )
}

function restoreExternalTabSession(tab: ExternalDesktopTab) {
  const cached = externalTabSessionRestores.get(tab.partition)
  if (cached) return cached

  // Persistent partitions retain durable cookies, but Chromium drops session cookies on exit.
  // Restore the encrypted snapshot before the first request so authentication is already available.
  const externalSession = session.fromPartition(tab.partition)
  const cookies = new Map(
    readExternalTabCookies(tab.partition).map((cookie) => [externalTabCookieKey(cookie), cookie] as const),
  )
  externalSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed) cookies.delete(externalTabCookieKey(cookie))
    if (!removed) cookies.set(externalTabCookieKey(cookie), cookie)
    writeExternalTabCookies(tab.partition, [...cookies.values()])
  })
  const restored = Promise.allSettled(
    [...cookies.values()]
      .filter(
        (cookie): cookie is Cookie & { domain: string } =>
          Boolean(cookie.domain) && (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000),
      )
      .map((cookie) =>
        externalSession.cookies.set({
          url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path ?? "/"}`,
          name: cookie.name,
          value: cookie.value,
          ...(!cookie.hostOnly && cookie.domain ? { domain: cookie.domain } : {}),
          ...(cookie.path ? { path: cookie.path } : {}),
          ...(cookie.secure ? { secure: true } : {}),
          ...(cookie.httpOnly ? { httpOnly: true } : {}),
          ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
          ...(!cookie.session && cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
        }),
      ),
  )
    .then(async (results) => {
      results.forEach((result) => {
        if (result.status === "rejected") {
          writeLog(
            "window",
            "external tab cookie restore failed",
            { partition: tab.partition, error: result.reason },
            "warn",
          )
        }
      })
      cookies.clear()
      ;(await externalSession.cookies.get({})).forEach((cookie) => cookies.set(externalTabCookieKey(cookie), cookie))
      writeExternalTabCookies(tab.partition, [...cookies.values()])
    })
    .catch((error) => {
      writeLog("window", "external tab session restore failed", { partition: tab.partition, error }, "error")
    })
  externalTabSessionRestores.set(tab.partition, restored)
  return restored
}

function externalTabCookieKey(cookie: Cookie) {
  return [cookie.name, cookie.domain ?? "", cookie.path ?? ""].join("\n")
}

function readExternalTabCookies(partition: string) {
  const value = getStore(DESKTOP_TAB_COOKIES_STORE).get(partition)
  if (typeof value !== "string" || !safeStorage.isEncryptionAvailable()) return []
  try {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64")))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isExternalTabCookie)
  } catch (error) {
    writeLog("window", "external tab cookies restore failed", { partition, error }, "error")
    return []
  }
}

function writeExternalTabCookies(partition: string, cookies: Cookie[]) {
  if (!safeStorage.isEncryptionAvailable()) {
    writeLog("window", "external tab cookies encryption unavailable", { partition }, "warn")
    return
  }
  try {
    getStore(DESKTOP_TAB_COOKIES_STORE).set(
      partition,
      safeStorage.encryptString(JSON.stringify(cookies)).toString("base64"),
    )
  } catch (error) {
    writeLog("window", "external tab cookies save failed", { partition, error }, "error")
  }
}

function isExternalTabCookie(value: unknown): value is Cookie {
  if (!value || typeof value !== "object") return false
  const cookie = value as Record<string, unknown>
  return (
    typeof cookie.name === "string" &&
    typeof cookie.value === "string" &&
    ["unspecified", "no_restriction", "lax", "strict"].includes(String(cookie.sameSite))
  )
}

function registerViewContextMenu(view: WebContentsView) {
  contextMenu({
    window: view,
    showSaveImageAs: true,
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    append: () => [
      {
        label: "Debug",
        click: () => {
          view.webContents.openDevTools()
        },
      },
    ],
  })
}

function registerDesktopTabsIpc() {
  if (desktopTabsIpcRegistered) return
  desktopTabsIpcRegistered = true

  ipcMain.on("desktop-tabs-subscribe", (event) => {
    desktopTabManagers.get(event.sender.id)?.sendState()
  })
  ipcMain.on("desktop-tabs-unsubscribe", () => {})
  ipcMain.on("desktop-tabs-select", (event, id: DesktopTabID) => {
    desktopTabManagers.get(event.sender.id)?.activate(id)
  })
  ipcMain.on("desktop-tabs-back", (event) => {
    desktopTabManagers.get(event.sender.id)?.back()
  })
  ipcMain.on("desktop-tabs-forward", (event) => {
    desktopTabManagers.get(event.sender.id)?.forward()
  })
  ipcMain.on("desktop-tabs-reload", (event) => {
    desktopTabManagers.get(event.sender.id)?.reload()
  })
  ipcMain.on("desktop-tabs-action", (event, action: DesktopTabAction) => {
    if (action !== "settings" && action !== "help") return
    desktopTabManagers.get(event.sender.id)?.action(action)
  })
}

function wireWindowRecovery(win: BrowserWindow, contents: WebContents, name: string) {
  let showing = false
  const sampler = createUnresponsiveSampler(win, name, contents)

  const handle = async (button: string | undefined, wait: boolean) => {
    if (button === "Export Logs") {
      const sampling = sampler.stopAndFlush()
      await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
      if (wait && sampling) sampler.start()
      return true
    }
    if (button === "Relaunch") {
      sampler.stopAndFlush()
      relaunchHandler()
      return false
    }
    if (button === "Quit") {
      sampler.stopAndFlush()
      app.quit()
    }
    return false
  }

  const show = async (message: string, detail: string, wait: boolean) => {
    if (showing || win.isDestroyed()) return
    showing = true
    try {
      while (!win.isDestroyed()) {
        const buttons = wait ? ["Relaunch", "Export Logs", "Keep Waiting"] : ["Relaunch", "Export Logs", "Quit"]
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        if (await handle(buttons[result.response], wait)) continue
        return
      }
    } finally {
      showing = false
    }
  }

  const failed = (
    event: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    writeLog(
      "window",
      "renderer load failed",
      {
        window: name,
        event,
        errorCode,
        errorDescription,
        validatedURL,
        currentURL: safeWebContentsURL(contents),
        isMainFrame,
      },
      "error",
    )

    if (!isMainFrame || errorCode === -3) return
    void show(
      "OpenCode failed to load",
      [`Window: ${name}`, `URL: ${validatedURL}`, `Error: ${errorCode} ${errorDescription}`].join("\n"),
      false,
    )
  }

  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  contents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-provisional-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  contents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog(
      "window",
      "renderer process gone",
      { window: name, currentURL: safeWebContentsURL(contents), details },
      "error",
    )
    void show(
      "OpenCode window terminated unexpectedly",
      [`Window: ${name}`, `Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
    )
  })
  contents.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, currentURL: safeWebContentsURL(contents) }, "error")
    sampler.start()
    void show("OpenCode is not responding", "You can relaunch the app, open the logs, or keep waiting.", true)
  })
  contents.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, currentURL: safeWebContentsURL(contents) }, "error")
    sampler.stopAndFlush()
  })
  contents.on("console-message", (event) => {
    if (event.message.toLowerCase().includes("terminal") || event.sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", {
        window: name,
        level: event.level,
        message: event.message,
        line: event.lineNumber,
        sourceId: event.sourceId,
      })
    }
  })
  contents.on("preload-error", (_event, preloadPath, error) => {
    writeLog("preload", "preload error", { window: name, preloadPath, error }, "error")
  })
}

function addDocumentPolicy(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) return response
  const headers = new Headers(response.headers)
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function allowRendererPermissions(contents: WebContents) {
  const webContentsId = contents.id

  contents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        isTrustedRendererUrl(details.requestingUrl) &&
        webContents.id === webContentsId,
    )
  })
  contents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission)) return false
    if (webContents && webContents.id !== webContentsId) return false
    return isTrustedRendererUrl(details.requestingUrl) || isTrustedRendererUrl(requestingOrigin)
  })
}

function isTrustedRendererUrl(value?: string) {
  return isRendererUrl(value)
}

function addRendererHeaders(value: string, headers: Record<string, HeaderValue>) {
  upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
  upsertKeyValue(headers, "Access-Control-Allow-Headers", ["*"])
  if (isRendererUrl(value, true)) upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
}

function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  return [process.env.ELECTRON_RENDERER_URL, process.env.ELECTRON_7777_RENDERER_URL].some((devUrl) => {
    if (!devUrl || !URL.canParse(devUrl)) return false
    return url.origin === new URL(devUrl).origin
  })
}

function wireZoom(win: BrowserWindow, contents: WebContents) {
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  contents.setZoomFactor(1)
  contents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault()
    if (pinchZoomEnabled.get(win)) {
      contents.setZoomFactor(clampZoom(contents.getZoomFactor() + (zoomDirection === "in" ? 0.2 : -0.2)))
      updateZoom(win)
      return
    }
    if (contents.getZoomFactor() !== 1) contents.setZoomFactor(1)
    updateZoom(win)
  })
}

function wireFullscreen(win: BrowserWindow) {
  const send = (fullscreen: boolean) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send("window-fullscreen-changed", fullscreen)
  }

  win.on("enter-full-screen", () => send(true))
  win.on("leave-full-screen", () => send(false))
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  const contents = getPrimaryWebContents(win)
  updateTitlebar(win)
  contents.send("zoom-factor-changed", contents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, HeaderValue>, keyToChange: string, value: HeaderValue) {
  const keyToChangeLower = keyToChange.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === keyToChangeLower) {
      // Reassign old key
      obj[key] = value
      // Done
      return
    }
  }
  // Insert at end instead
  obj[keyToChange] = value
}
