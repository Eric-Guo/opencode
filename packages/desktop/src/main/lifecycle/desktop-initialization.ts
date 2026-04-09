export * as DesktopInitialization from "./desktop-initialization"

import { app, session } from "electron"
import { Context, Effect, Layer } from "effect"
import { DesktopLogging } from "../native/logging"
import { configureProxyCommandLine, configureSessionProxy } from "../proxy"
import { getStore } from "../storage/store"
import { marks } from "./marks"
import {
  loadProxyEnvironment,
  preferApplicationEnvironment,
  prepareApplicationEnvironment,
  prepareDesktop,
} from "./environment"

export interface Interface {
  readonly version: string
  readonly updaterStore: ReturnType<typeof getStore>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopInitialization") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const logging = yield* DesktopLogging.Service
    yield* preferApplicationEnvironment
    const commandLineProxy = configureProxyCommandLine(app.commandLine)
    if (commandLineProxy)
      yield* Effect.logInfo("electron proxy configured from environment", {
        hasBypassRules: Boolean(commandLineProxy.proxyBypassRules),
      })
    // System certificates, the proxy and the net log serve later network work; the first window and
    // its IPC port do not wait for them.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* prepareApplicationEnvironment
        yield* loadProxyEnvironment
        yield* Effect.promise(() => app.whenReady())
        const sessionProxy = yield* Effect.promise(() => configureSessionProxy(session.defaultSession))
        if (sessionProxy)
          yield* Effect.logInfo("electron session proxy applied", {
            hasBypassRules: Boolean(sessionProxy.proxyBypassRules),
          })
        yield* logging.startNetwork
      }),
    )
    yield* Effect.promise(() => app.whenReady())
    yield* prepareDesktop
    marks.init = Date.now()
    return Service.of({
      version: app.getVersion(),
      updaterStore: getStore("opencode.updater"),
    })
  }),
)
