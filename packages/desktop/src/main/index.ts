import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { ensureSsoUsername } from "../../../opencode/src/util/thape_sso"
import type { Event } from "electron"
import { app, BrowserWindow, session } from "electron"
import contextMenu from "electron-context-menu"
import { Deferred, Effect, Fiber } from "effect"

import type { InitStep, ServerReadyData, SqliteMigrationProgress } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { migrate } from "./migrate"
import { createMenu } from "./menu"
import {
  allocatePort,
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  spawnWslSidecar,
  type SidecarListener,
} from "./server"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { createWslServersController } from "./wsl-servers"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { configureNodeProxyFromEnv, configureProxyCommandLine, configureSessionProxy } from "./proxy"
import { getUserShell, loadShellEnv, mergeShellEnv } from "./shell-env"

const APP_NAMES: Record<string, string> = {
  dev: "SigmaAgents",
  beta: "SigmaAgents",
  prod: "SigmaAgents",
}

const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop",
  beta: "ai.opencode.desktop",
  prod: "ai.opencode.desktop",
}

const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null
let wslServers: ReturnType<typeof createWslServersController> | null = null

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  configureNodeProxyFromEnv((error) => logger.warn("failed to load proxy environment", error))
}

function getStartupEnv() {
  if (process.platform === "win32") return process.env
  const shell = getUserShell()
  return mergeShellEnv(loadShellEnv(shell), process.env)
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

async function killAllSidecars() {
  await killSidecar()
  wslServers?.stopAll()
}

function relaunchApp() {
  void killAllSidecars().finally(() => {
    app.relaunch()
    app.exit(0)
  })
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

function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

const main = Effect.gen(function* () {
  contextMenu({
    showSaveImageAs: true,
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    append: (_defaultActions, _parameters, browserWindow) => [
      {
        label: "Debug",
        click: () => {
          if (browserWindow && "webContents" in browserWindow) {
            browserWindow.webContents.openDevTools()
          }
        },
      },
    ],
  })

  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()

  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "SigmaAgents")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))

  logger = initLogging()
  wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      log: (message, meta) => logger.log(message, meta),
      error: (message, meta) => logger.error(message, meta),
    },
  )

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  const startupEnv = getStartupEnv()
  ensureLoopbackNoProxy()
  useEnvProxy()
  const commandLineProxy = configureProxyCommandLine(app.commandLine, startupEnv)
  if (!commandLineProxy) app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (commandLineProxy)
    logger.log("electron proxy configured from environment", {
      hasBypassRules: Boolean(commandLineProxy.proxyBypassRules),
    })
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    void killAllSidecars()
  })

  app.on("will-quit", () => {
    void killAllSidecars()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void killAllSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData>()
  const loadingComplete = Deferred.makeUnsafe<void>()

  const controller = wslServers
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch: () => relaunchApp(),
    awaitInitialization: Effect.fnUntraced(
      function* (sendStep) {
        sendStep(initStep)
        const listener = (step: InitStep) => sendStep(step)
        initEmitter.on("step", listener)
        try {
          logger.log("awaiting server ready")
          const res = yield* Deferred.await(serverReady)
          logger.log("server ready", { url: res.url })
          return res
        } finally {
          initEmitter.off("step", listener)
        }
      },
      (e) => Effect.runPromise(e),
    ),
    getWslServersState: () => controller.getState(),
    onWslServersEvent: (listener) => controller.subscribe(listener),
    wslServersProbeRuntime: () => controller.probeRuntime(),
    wslServersRefreshDistros: () => controller.refreshDistros(),
    wslServersInstallWsl: () => controller.installWsl(),
    wslServersInstallDistro: (name) => controller.installDistro(name),
    wslServersProbeDistro: (name) => controller.probeDistro(name),
    wslServersProbeOpencode: (name) => controller.probeOpencode(name),
    wslServersInstallOpencode: (name) => controller.installOpencode(name),
    wslServersOpenTerminal: (name) => controller.openTerminal(name),
    wslServersAddServer: (distro) => controller.addServer(distro),
    wslServersRemoveServer: (id) => controller.removeServer(id),
    wslServersStartServer: (id) => controller.startServer(id),
    getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    wslPath: async (path, mode, distro) => wslPath(path, mode, distro),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    loadingWindowComplete: () => Deferred.doneUnsafe(loadingComplete, Effect.void),
    runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killAllSidecars),
    checkUpdate: async () => checkUpdate(),
    installUpdate: async () => installUpdate(killAllSidecars),
    setBackgroundColor: (color) => setBackgroundColor(color),
  })

  yield* Effect.promise(() => app.whenReady())

  const sessionProxy = yield* Effect.promise(() => configureSessionProxy(session.defaultSession, startupEnv))
  if (sessionProxy)
    logger.log("electron session proxy applied", {
      hasBypassRules: Boolean(sessionProxy.proxyBypassRules),
    })
  if (!TEST_ONBOARDING) migrate()
  app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  setupAutoUpdater()
  yield* Effect.promise(() => ensureSsoUsername())

  const needsMigration = !sqliteFileExists() && process.env.OPENCODE_DB !== ":memory:"
  let overlay: BrowserWindow | null = null

  const port = yield* Effect.promise(() => allocatePort())
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(
        hostname,
        port,
        password,
        () => {
          ensureLoopbackNoProxy()
          useEnvProxy()
        },
        {
          needsMigration,
          userDataPath: app.getPath("userData"),
          onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
          onStdout: (message) => logger.log("sidecar stdout", { message }),
          onStderr: (message) => logger.warn("sidecar stderr", { message }),
          onExit: (code) => logger.warn("sidecar exited", { code }),
        },
      ),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    void controller.initialize().catch((error) => logger.error("wsl server initialization failed", error))

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(Effect.forkChild)

  if (needsMigration) {
    const show = yield* loadingTask.pipe(
      Fiber.await,
      Effect.timeout("1 second"),
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    )
    if (show) {
      overlay = createLoadingWindow()
      yield* Effect.sleep("1 second")
    }
  }

  yield* Fiber.await(loadingTask)
  setInitStep({ phase: "done" })

  if (overlay) yield* Deferred.await(loadingComplete)

  mainWindow = createMainWindow()
  if (mainWindow) {
    createMenu({
      trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
      checkForUpdates: () => {
        void checkForUpdates(true, killAllSidecars)
      },
      reload: () => mainWindow?.reload(),
      relaunch: () => relaunchApp(),
    })
  }

  overlay?.close()
})

Effect.runFork(main)
