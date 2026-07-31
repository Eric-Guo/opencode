export * as DesktopInitialization from "./desktop-initialization"

import { app, session } from "electron"
import { Context, Effect, Layer } from "effect"
import { ensureSsoUsername } from "@opencode-ai/core/thape-sso"
import { ensureKimiWebBridgeDaemon } from "../kimi-webbridge"
import { DesktopLogging } from "../native/logging"
import { configureProxyCommandLine, configureSessionProxy } from "../proxy"
import { getStore } from "../storage/store"
import { loadSsoBearerApiKey } from "../thape-sso"
import {
  loadProxyEnvironment,
  preferApplicationEnvironment,
  prepareApplicationEnvironment,
  prepareDesktop,
} from "./environment"
import { initializeFirstLaunchOnboarding } from "./onboarding"

export interface Interface {
  readonly version: string
  readonly updaterStore: ReturnType<typeof getStore>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopInitialization") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const logging = yield* DesktopLogging.Service
    const runFork = Effect.runForkWith(yield* Effect.context())
    yield* initializeFirstLaunchOnboarding(app.getPath("userData"))
    yield* prepareApplicationEnvironment
    yield* preferApplicationEnvironment
    const commandLineProxy = configureProxyCommandLine(app.commandLine)
    if (commandLineProxy)
      yield* Effect.logInfo("electron proxy configured from environment", {
        hasBypassRules: Boolean(commandLineProxy.proxyBypassRules),
      })
    yield* loadProxyEnvironment
    yield* Effect.promise(() => app.whenReady())
    yield* Effect.sync(() => {
      void ensureKimiWebBridgeDaemon({
        logger: {
          log: (message, meta) => runFork(Effect.logInfo(message, meta)),
          warn: (message, meta) => runFork(Effect.logWarning(message, meta)),
        },
      })
    })
    const sessionProxy = yield* Effect.promise(() => configureSessionProxy(session.defaultSession))
    if (sessionProxy)
      yield* Effect.logInfo("electron session proxy applied", {
        hasBypassRules: Boolean(sessionProxy.proxyBypassRules),
      })
    const ssoBearerApiKey = yield* Effect.promise(() =>
      loadSsoBearerApiKey(app.getPath("userData"), process.env.THAPE_SSO_BEARER_API_KEY),
    )
    if (ssoBearerApiKey) process.env.THAPE_SSO_BEARER_API_KEY = ssoBearerApiKey
    yield* Effect.promise(() => ensureSsoUsername())
    yield* logging.startNetwork
    yield* prepareDesktop
    return Service.of({
      version: app.getVersion(),
      updaterStore: getStore("opencode.updater"),
    })
  }),
)
