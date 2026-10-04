import type { WebContents } from "electron"
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js"
import { protocolError } from "./errors"

type CdpEvent = ProtocolMapping.Events[keyof ProtocolMapping.Events][0]

export type Cdp = ReturnType<typeof createCdp>

export function createCdp(contents: WebContents) {
  const listeners = new Map<string, Set<(params: CdpEvent, sessionID?: string) => void>>()
  const sessions = new Set([""])

  const receive = (_event: Electron.Event, name: string, params: CdpEvent, sessionID?: string) => {
    if (!sessions.has(sessionID ?? "")) return

    if (name === "Target.attachedToTarget") {
      // SAFETY: Electron reports Target.attachedToTarget with the payload for that exact CDP event name.
      const event = params as ProtocolMapping.Events["Target.attachedToTarget"][0]

      if (event.targetInfo.type === "iframe") sessions.add(event.sessionId)
    }

    if (name === "Target.detachedFromTarget") {
      // SAFETY: The event name selects the detached-target payload from Chromium's CDP event mapping.
      const event = params as ProtocolMapping.Events["Target.detachedFromTarget"][0]
      sessions.delete(event.sessionId)
    }

    listeners.get(name)?.forEach((callback) => callback(params, sessionID || undefined))
  }

  contents.debugger.on("message", receive)

  return {
    async send<Method extends keyof ProtocolMapping.Commands>(
      method: Method,
      params?: ProtocolMapping.Commands[Method]["paramsType"] extends []
        ? Record<string, never>
        : ProtocolMapping.Commands[Method]["paramsType"][number],
      sessionID?: string,
    ): Promise<ProtocolMapping.Commands[Method]["returnType"]> {
      if (contents.isDestroyed())
        throw new Error(
          "Browser tab was closed. Call browser.tabs.list({}) and choose an existing tabID, or browser.tabs.open({}) if no tabs remain.",
        )

      // attach can throw synchronously; sendCommand can reject asynchronously.
      try {
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")

        return await contents.debugger.sendCommand(method, params ?? {}, sessionID)
      } catch (error) {
        throw protocolError(method, error)
      }
    },
    on<Method extends keyof ProtocolMapping.Events>(
      method: Method,
      callback: (params: ProtocolMapping.Events[Method][0], sessionID?: string) => void,
    ) {
      // SAFETY: Listeners are indexed by the same event name used to select their typed callback.
      const handler = (params: CdpEvent, sessionID?: string) =>
        callback(params as ProtocolMapping.Events[Method][0], sessionID)

      const handlers = listeners.get(method) ?? new Set()
      handlers.add(handler)
      listeners.set(method, handlers)

      return () => {
        handlers.delete(handler)

        if (!handlers.size) listeners.delete(method)
      }
    },
    dispose() {
      contents.debugger.off("message", receive)
      listeners.clear()
    },
  }
}

export function abortError(signal: AbortSignal) {
  if (signal.aborted)
    throw new Error(
      "Browser operation was cancelled. Inspect the tab before deciding to repeat an action; cancellation does not undo changes already made.",
    )
}

export async function waitFor(check: () => boolean | Promise<boolean>, signal: AbortSignal, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  const timeout = () => new Error(`Condition was not met within ${timeoutMs} ms.`)

  // A busy renderer can hold one check past the deadline, so each check races the remaining time.
  while (true) {
    abortError(signal)
    const remaining = deadline - Date.now()

    if (remaining <= 0) throw timeout()
    let timer: ReturnType<typeof setTimeout> | undefined

    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeout()), remaining)
    })

    if (await Promise.race([check(), expired]).finally(() => clearTimeout(timer))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
