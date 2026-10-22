export * as DesktopProxy from "./network"

import { Context, Effect, Layer } from "effect"
import type { Session } from "electron"
import { DesktopStorage } from "./storage"
import { createStateStore } from "./storage/state"
import { createProxySettings } from "./proxy-settings"
import { createSessionProxy, getProxyEnvironment, getSessionProxyConfig } from "./proxy"

export interface Interface extends ReturnType<typeof createProxySettings> {
  readonly environment: () => Record<string, string>
  readonly prepare: (session: Session) => Promise<void>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopProxy") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* DesktopStorage.Service
    // This namespace has its own immediate writer so failed saves propagate to the form.
    const state = createStateStore(storage.db)
    yield* Effect.addFinalizer(() => Effect.sync(() => state.close()))
    const settings = createProxySettings(state)
    const environment = () => getProxyEnvironment(settings.active, process.env)
    // Resolve lazily, after the login shell and distribution environment hooks have run.
    let prepare: ReturnType<typeof createSessionProxy> | undefined

    return Service.of({
      ...settings,
      environment,
      prepare: (session) =>
        (prepare ??= createSessionProxy(getSessionProxyConfig(settings.active, environment())))(session),
    })
  }),
)
