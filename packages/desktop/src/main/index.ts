import { ensureSsoUsername } from "@opencode-ai/core/thape-sso"
import { app, session } from "electron"
import { Deferred, Effect, Fiber } from "effect"
import type { ServerReadyData } from "../shared/ipc-contract"
import { checkAppExists, resolveAppPath } from "./files/apps"
import { registerIpcHandlers, registerUpdaterIpcHandlers, registerWslIpcHandlers } from "./ipc"
import { ensureKimiWebBridgeDaemon } from "./kimi-webbridge"
import { loadDesktopTabs } from "./desktop-tabs"
import {
  acquireApplicationLock,
  configureApplication,
  loadProxyEnvironment,
  preferApplicationEnvironment,
  prepareDesktop,
} from "./lifecycle/environment"
import { createApplicationLifecycle } from "./lifecycle"
import { finishFirstLaunchOnboarding, isFirstLaunchOnboardingPending } from "./lifecycle/onboarding"
import { exportDebugLogs, startNetworkLogging, writeLog } from "./native/logging"
import { createMenu, sendMenuCommand } from "./native/menu"
import { setNativeTranslations } from "./native/translations"
import { configureProxyCommandLine, configureSessionProxy } from "./proxy"
import { startBackgroundCli } from "./service/background-service"
import { forwardInitializationFailure } from "./service/initialization"
import { getDefaultServerUrl, setDefaultServerUrl } from "./service/server-settings"
import { createUpdaterIpc, setupAutoUpdater, showUpdaterDialog, startAutoUpdater } from "./updater"
import {
  getDesktopTabHistory,
  getLastFocusedWindow,
  goToDesktopTabHistory,
  setBackgroundColor,
  subscribeDesktopTabHistory,
} from "./windows"
import { startWsl } from "./wsl/start"

const main = Effect.gen(function* () {
  const logger = configureApplication()
  if (!acquireApplicationLock()) return
  preferApplicationEnvironment(logger)
  const commandLineProxy = configureProxyCommandLine(app.commandLine)
  if (commandLineProxy)
    logger.log("electron proxy configured from environment", {
      hasBypassRules: Boolean(commandLineProxy.proxyBypassRules),
    })
  const lifecycle = createApplicationLifecycle(logger)
  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())
  void ensureKimiWebBridgeDaemon({
    logger: {
      log: (message, meta) => logger.log(message, meta),
      warn: (message, meta) => logger.warn(message, meta),
    },
  })
  yield* prepareDesktop(logger)

  const updater = setupAutoUpdater(lifecycle.prepareToRestart)
  const menu = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater),
    relaunch: lifecycle.relaunch,
    getHistory: () => getDesktopTabHistory(getLastFocusedWindow()),
    goToHistory: (index: number) => goToDesktopTabHistory(getLastFocusedWindow(), index),
    onHistoryChange: subscribeDesktopTabHistory,
  }
  registerIpcHandlers({
    relaunch: lifecycle.relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const result = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: result.url, OPENCODE_SERVER_PASSWORD: result.password })
        return result
      },
      (effect) => Effect.runPromise(effect),
    ),
    consumeInitialDeepLinks: lifecycle.consumeInitialDeepLinks,
    getDefaultServerUrl,
    setDefaultServerUrl,
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    checkAppExists,
    resolveAppPath: async (appName) => resolveAppPath(appName),
    showUpdater: () => showUpdaterDialog(updater),
    setBackgroundColor,
    exportDebugLogs,
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menu)
    },
  })
  registerUpdaterIpcHandlers(createUpdaterIpc(updater))
  const sessionProxy = yield* Effect.promise(() => configureSessionProxy(session.defaultSession))
  if (sessionProxy)
    logger.log("electron session proxy applied", {
      hasBypassRules: Boolean(sessionProxy.proxyBypassRules),
    })
  startAutoUpdater(updater)
  yield* Effect.promise(() => ensureSsoUsername())
  yield* Effect.promise(() => startNetworkLogging())

  const loadingTask = yield* Effect.gen(function* () {
    loadProxyEnvironment(logger)
    logger.log("starting v2 background service")
    const background = yield* Effect.promise(() =>
      startBackgroundCli(logger, {
        cors: loadDesktopTabs().flatMap((tab) =>
          "url" in tab && tab.localServer ? [new URL(tab.url).origin] : [],
        ),
      }),
    )
    const wsl = yield* Effect.promise(() => startWsl(background, logger))
    registerWslIpcHandlers(wsl.ipc)
    wsl.start()
    lifecycle.setWslShutdown(wsl.stop)
    yield* Deferred.succeed(serverReady, {
      url: background.url,
      username: background.username,
      password: background.password,
      ...(process.env.THAPE_SSO_BEARER_API_KEY
        ? { ssoJwtSecretKey: process.env.THAPE_SSO_BEARER_API_KEY }
        : {}),
    })
    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)
  if (lifecycle.restoreWindows().length) createMenu(menu)
})

Effect.runFork(main)
