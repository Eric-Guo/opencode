import windowState from "electron-window-state"
import { BrowserWindow } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Globals = {
  updaterEnabled: boolean
  wsl: boolean
  deepLinks?: string[]
}

const root = dirname(fileURLToPath(import.meta.url))

export function createMainWindow(globals: Globals) {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: true,
    title: "OpenCode",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 12, y: 18 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "transparent",
            symbolColor: "#999",
            height: 40,
          },
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.mjs"),
      sandbox: false,
    },
  })

  state.manage(win)
  loadWindow(win, "index.html")
  wireZoom(win)
  injectGlobals(win, globals)

  return win
}

export function createLoadingWindow(globals: Globals) {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 12, y: 18 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "transparent",
            symbolColor: "#999",
            height: 40,
          },
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.mjs"),
      sandbox: false,
    },
  })

  loadWindow(win, "loading.html")
  injectGlobals(win, globals)

  return win
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadFile(join(root, `../renderer/${html}`))
}

function injectGlobals(win: BrowserWindow, globals: Globals) {
  win.webContents.on("dom-ready", () => {
    const data = {
      updaterEnabled: globals.updaterEnabled,
      wsl: globals.wsl,
      deepLinks: globals.deepLinks ?? [],
    }
    void win.webContents.executeJavaScript(
      `window.__OPENCODE__ = Object.assign(window.__OPENCODE__ ?? {}, ${JSON.stringify(data)})`,
    )
  })
}

function wireZoom(win: BrowserWindow) {
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1)
  })
}
