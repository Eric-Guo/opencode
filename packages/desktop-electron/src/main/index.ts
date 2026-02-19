import { app, BrowserWindow, dialog } from "electron"

app.setName(app.isPackaged ? "OpenCode" : "OpenCode Dev")
import type { Event } from "electron"
import pkg from "electron-updater"
const { autoUpdater } = pkg
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"

import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { getConfig, installCli, syncCli } from "./cli"
import { UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging, tail } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  checkHealth,
  checkHealthOrAskRetry,
  getDefaultServerUrl,
  getSavedServerUrl,
  getWslConfig,
  setDefaultServerUrl,
  setWslConfig,
  spawnLocalServer,
} from "./server"
import { createLoadingWindow, createMainWindow, setDockIcon } from "./windows"

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import type { CommandChild } from "./cli"

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let loadingWindow: BrowserWindow | null = null
let sidecar: CommandChild | null = null
let loadingComplete = defer<void>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()

setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) emitDeepLinks(urls)
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    killSidecar()
  })

  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("opencode")
    setDockIcon()
    setupAutoUpdater()
    syncCli()
    await initialize()
  })
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function setInitStep(step: InitStep) {
  initStep = step
  initEmitter.emit("step", step)
}

async function initialize() {
  const config = await getConfig().catch(() => null)
  const customUrl = await getSavedServerUrl(config)

  const init = (async () => {
    if (customUrl && (await checkHealthOrAskRetry(customUrl))) {
      serverReady.resolve({ url: customUrl, password: null })
      return
    }

    const port = await getSidecarPort()
    const hostname = "127.0.0.1"
    const localUrl = `http://${hostname}:${port}`

    if (await checkHealth(localUrl)) {
      serverReady.resolve({ url: localUrl, password: null })
      return
    }

    const password = randomUUID()
    const { child, health, events } = spawnLocalServer(hostname, port, password)
    sidecar = child

    const needsMigration = !sqliteFileExists()
    const sqliteDone = defer<void>()

    events.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (loadingWindow) sendSqliteMigrationProgress(loadingWindow, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
      if (progress.type === "Done") sqliteDone.resolve()
    })

    const healthTask = (async () => {
      if (needsMigration) await sqliteDone.promise
      await health.wait
    })()

    try {
      await healthTask
    } catch (error) {
      serverReady.reject(new Error(`Failed to spawn OpenCode Server (${String(error)}). Logs:\n${tail()}`))
      return
    }

    serverReady.resolve({ url: localUrl, password })
  })()

  let showLoading = false
  if (!sqliteFileExists()) {
    showLoading = await Promise.race([init.then(() => false).catch(() => false), delay(1000).then(() => true)])
  }

  const globals = {
    updaterEnabled: UPDATER_ENABLED,
    wsl: getWslConfig().enabled,
    deepLinks: pendingDeepLinks.splice(0),
  }

  if (showLoading) {
    loadingWindow = createLoadingWindow(globals)
  } else {
    mainWindow = createMainWindow(globals)
    wireMenu()
  }

  await init
  setInitStep({ phase: "done" })

  if (loadingWindow) {
    await loadingComplete.promise
  }

  if (!mainWindow) {
    mainWindow = createMainWindow(globals)
    wireMenu()
  }

  if (loadingWindow) {
    loadingWindow.close()
    loadingWindow = null
  }
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    installCli: () => {
      void installCli()
    },
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      killSidecar()
      app.relaunch()
      app.exit(0)
    },
  })
}

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  installCli: async () => installCli(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      return await serverReady.promise
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
})

function killSidecar() {
  if (!sidecar) return
  sidecar.kill()
  sidecar = null
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "anomalyco",
    repo: "opencode",
  })
}

let updateReady = false

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  updateReady = false
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (!version) return { updateAvailable: false }
    await autoUpdater.downloadUpdate()
    updateReady = true
    return { updateAvailable: true, version }
  } catch {
    return { updateAvailable: false }
  }
}

async function installUpdate() {
  if (!updateReady) return
  killSidecar()
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  try {
    const result = await checkUpdate()
    if (!result.updateAvailable) {
      if (alertOnFail) {
        await dialog.showMessageBox({
          type: "info",
          message: "You're up to date.",
          title: "No Updates",
        })
      }
      return
    }

    const response = await dialog.showMessageBox({
      type: "info",
      message: `Update ${result.version ?? ""} downloaded. Restart now?`,
      title: "Update Ready",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response.response === 0) {
      await installUpdate()
    }
  } catch {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "error",
      message: "Update check failed.",
      title: "Update Error",
    })
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
