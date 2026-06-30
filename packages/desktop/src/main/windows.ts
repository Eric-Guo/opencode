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
  shell,
} from "electron"
import type { WebContents } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { exportDebugLogs, write as writeLog } from "./logging"
import { getStore } from "./store"
import { PINCH_ZOOM_ENABLED_KEY, WINDOW_IDS_KEY } from "./store-keys"
import { createUnresponsiveSampler } from "./unresponsive"

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

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
])

let backgroundColor: string | undefined
let relaunchHandler = () => {
  app.relaunch()
  app.exit(0)
}
let appQuitting = false
let lastFocusedWindowID: string | undefined
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const windowIDs = new WeakMap<BrowserWindow, string>()
const windowsByID = new Map<string, BrowserWindow>()
const primaryWebContents = new WeakMap<BrowserWindow, WebContents>()
const webContentsOwners = new Map<number, BrowserWindow>()
const titlebarHeight = 40
const tabbarWidth = 72
const maxZoomLevel = 10
const minZoomLevel = 0.2
const helpURL = "https://plm.thape.com.cn/projects/opencode/wiki/01-shi-yong-shuo-ming"
const desktopTabs = [
  { id: "opencode", title: "OpenCode", label: "OC" },
  {
    id: "plm",
    title: "PLM",
    label: "PLM",
    url: "https://plm.thape.com.cn",
    partition: "persist:desktop-tab-plm",
  },
] as const
const desktopTabManagers = new Map<number, DesktopTabManager>()

type DesktopTabID = (typeof desktopTabs)[number]["id"]
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

export function setAppQuitting() {
  appQuitting = true
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => win.setBackgroundColor(color))
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

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), getPrimaryWebContents(win).getZoomFactor()))
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
  if (!lastFocusedWindowID) return null
  const win = windowsByID.get(lastFocusedWindowID)
  if (!win || win.isDestroyed()) return null
  return win
}

export function restoreMainWindows() {
  const ids = readWindowIDs()
  return (ids.length ? ids : [randomUUID()]).map((id) => createMainWindow(id))
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow(id: string = randomUUID()) {
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
          trafficLightPosition: { x: 12, y: 14 },
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
  const tabManager = createDesktopTabManager(win, openCodeView, tabbarView)

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
  wireZoom(win, openCodeView.webContents)
  tabManager.load()

  void loadWebContents(openCodeView.webContents, "index.html").finally(() => {
    if (!win.isDestroyed()) win.show()
  })

  return win
}

function registerWindow(win: BrowserWindow, id: string) {
  windowIDs.set(win, id)
  windowsByID.set(id, win)
  persistWindowID(id)

  win.on("focus", () => {
    lastFocusedWindowID = id
  })
  win.on("closed", () => {
    windowsByID.delete(id)
    if (lastFocusedWindowID === id) lastFocusedWindowID = windowsByID.keys().next().value
    if (!appQuitting) removeWindowID(id)
  })
}

function readWindowIDs() {
  const value = getStore().get(WINDOW_IDS_KEY)
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === "string" && id.length > 0)
}

function writeWindowIDs(ids: string[]) {
  getStore().set(WINDOW_IDS_KEY, [...new Set(ids)])
}

function persistWindowID(id: string) {
  const ids = readWindowIDs()
  if (ids.includes(id)) return
  writeWindowIDs([...ids, id])
}

function removeWindowID(id: string) {
  writeWindowIDs(readWindowIDs().filter((item) => item !== id))
  rmSync(join(app.getPath("userData"), windowStateFile(id)), { force: true })
}

function windowStateFile(id: string) {
  return `window-state-${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
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
      const response = await net.fetch(pathToFileURL(file).toString())
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

function loadWebContents(contents: WebContents, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
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
  registerViewContextMenu(view)
  view.setBackgroundColor("#111315")
  win.contentView.addChildView(view)
  return view
}

function createDesktopTabManager(win: BrowserWindow, openCodeView: WebContentsView, tabbarView: WebContentsView) {
  registerDesktopTabsIpc()
  const tabbarWebContents = tabbarView.webContents
  const tabbarWebContentsId = tabbarWebContents.id
  tabbarWebContents.once("destroyed", () => {
    desktopTabManagers.delete(tabbarWebContentsId)
  })

  let active: DesktopTabID = "opencode"
  const externalViews = new Map<DesktopTabID, WebContentsView>()

  function getView(id: DesktopTabID) {
    if (id === "opencode") return openCodeView
    return externalViews.get(id)
  }

  function getActiveView() {
    return getView(active) ?? openCodeView
  }

  function getExternalTab(id: DesktopTabID) {
    return desktopTabs.find(
      (tab): tab is Extract<(typeof desktopTabs)[number], { url: string }> => tab.id === id && "url" in tab,
    )
  }

  function ensureView(id: DesktopTabID) {
    if (id === "opencode") return openCodeView
    const cached = externalViews.get(id)
    if (cached) return cached
    const tab = getExternalTab(id)
    if (!tab) return openCodeView
    const view = createExternalView(win, tab, sendState)
    externalViews.set(id, view)
    win.contentView.addChildView(view)
    view.setVisible(false)
    layout()
    return view
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
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
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
    externalViews.forEach((view) => {
      view.setBounds({ x: tabbarWidth, y: 0, width: contentWidth, height: bounds.height })
    })
  }

  function activate(id: DesktopTabID) {
    if (!desktopTabs.some((tab) => tab.id === id)) return
    active = id
    const activeView = ensureView(id)
    openCodeView.setVisible(id === "opencode")
    externalViews.forEach((view, viewID) => {
      view.setVisible(viewID === id)
    })
    win.contentView.addChildView(tabbarView)
    layout()
    sendState()
    activeView.webContents.focus()
  }

  function navigate(direction: "back" | "forward") {
    const contents = getActiveView().webContents
    if (direction === "back" && contents.canGoBack()) contents.goBack()
    if (direction === "forward" && contents.canGoForward()) contents.goForward()
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

function createExternalView(
  win: BrowserWindow,
  tab: Extract<(typeof desktopTabs)[number], { url: string }>,
  sendState: () => void,
) {
  const view = new WebContentsView({
    webPreferences: {
      partition: tab.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trackWebContents(win, view.webContents)
  registerViewContextMenu(view)
  view.setBackgroundColor("#ffffff")
  view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  view.webContents.session.setPermissionCheckHandler(() => false)
  view.webContents.setWindowOpenHandler((details) => {
    void view.webContents.loadURL(details.url)
    return { action: "deny" }
  })
  view.webContents.on("did-navigate", sendState)
  view.webContents.on("did-navigate-in-page", sendState)
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
  void view.webContents.loadURL(tab.url).catch((error) => {
    writeLog("window", "external tab initial load failed", { tab: tab.id, error }, "error")
  })
  return view
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
        currentURL: contents.getURL(),
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
      { window: name, currentURL: contents.getURL(), details },
      "error",
    )
    void show(
      "OpenCode window terminated unexpectedly",
      [`Window: ${name}`, `Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
    )
  })
  contents.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, currentURL: contents.getURL() }, "error")
    sampler.start()
    void show("OpenCode is not responding", "You can relaunch the app, open the logs, or keep waiting.", true)
  })
  contents.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, currentURL: contents.getURL() }, "error")
    sampler.stopAndFlush()
  })
  contents.on("console-message", (_event, level, message, line, sourceId) => {
    if (message.toLowerCase().includes("terminal") || sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", { window: name, level, message, line, sourceId })
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

function addRendererHeaders(value: string, headers: Record<string, any>) {
  upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
  upsertKeyValue(headers, "Access-Control-Allow-Headers", ["*"])
  if (isRendererUrl(value, true)) upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
}

function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
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

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  const contents = getPrimaryWebContents(win)
  updateTitlebar(win)
  contents.send("zoom-factor-changed", contents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, any>, keyToChange: string, value: any) {
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
