export * as DesktopInitialization from "./desktop-initialization"

import { app, session } from "electron"
import { Context, Effect, Layer } from "effect"
import { ensureSsoUsername } from "@opencode/core/thape-sso"
import { ensureKimiWebBridgeDaemon } from "../kimi-webbridge"
import { DesktopLogging } from "../native/logging"
import { configureNodeProxyFromEnv } from "../proxy"
import { DesktopProxy } from "../network"
import { marks } from "./marks"
import extension from "#desktop-main-extension"
import { preferApplicationEnvironment, prepareApplicationEnvironment, prepareDesktop } from "./environment"

export interface Interface {
  readonly version: string
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopInitialization") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const logging = yield* DesktopLogging.Service
    const proxy = yield* DesktopProxy.Service
    const runFork = Effect.runForkWith(yield* Effect.context())
    yield* preferApplicationEnvironment
    yield* prepareApplicationEnvironment
    yield* Effect.try(() => configureNodeProxyFromEnv(proxy.environment())).pipe(
      Effect.catch((error) => Effect.logWarning("failed to load proxy environment", { error })),
    )
    yield* Effect.promise(() => app.whenReady())
    yield* Effect.promise(() => proxy.prepare(session.defaultSession))
    yield* Effect.forkScoped(logging.startNetwork)
    yield* Effect.sync(() => {
      void ensureKimiWebBridgeDaemon({
        logger: {
          log: (message, meta) => runFork(Effect.logInfo(message, meta)),
          warn: (message, meta) => runFork(Effect.logWarning(message, meta)),
        },
      })
    })

    if (extension.initialize) yield* Effect.promise(() => extension.initialize!())
    yield* Effect.promise(() => ensureSsoUsername())
    yield* prepareDesktop
    marks.init = Date.now()

    return Service.of({
      version: app.getVersion(),
    })
  }),
)
