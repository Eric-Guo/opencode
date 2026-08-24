export * as BackgroundService from "./background-service"

import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { UtilityProcess } from "electron"
import { Context, Effect, Layer } from "effect"
import type { ServerReadyData } from "../../shared/ipc-contract"
import { Shutdown } from "../lifecycle/shutdown"
import { BackgroundServiceState } from "./background-service-state"

type SidecarMessage =
  | { type: "starting"; stage: string }
  | { type: "diagnostic"; message: string }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export interface Interface {
  readonly connection: Effect.Effect<ServerReadyData>
  readonly reconnect: Effect.Effect<ServerReadyData>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BackgroundService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const child = { current: undefined as UtilityProcess | undefined }
    const runFork = Effect.runForkWith(yield* Effect.context())
    const connect = Effect.tryPromise(async () => {
      await app.whenReady()
      if (child.current) await stop(child.current)
      const port = await allocatePort()
      const password = randomUUID()
      child.current = await start(port, password, (message) =>
        runFork(Effect.logInfo("embedded server sidecar", { message })),
      )
      return {
        url: `http://127.0.0.1:${port}`,
        password,
      } satisfies ServerReadyData
    })
    const state = yield* BackgroundServiceState.make({ initial: connect, reconnect: connect.pipe(Effect.orDie) })
    const shutdown = yield* Shutdown.Service
    const stopCurrent = Effect.promise(async () => {
      if (!child.current) return
      await stop(child.current)
      child.current = undefined
    })
    const removeShutdown = yield* shutdown.add(stopCurrent)
    yield* Effect.addFinalizer(() => Effect.sync(removeShutdown).pipe(Effect.andThen(stopCurrent)))
    return Service.of(state)
  }),
)

function start(port: number, password: string, diagnostic: (message: string) => void) {
  return new Promise<UtilityProcess>((resolve, reject) => {
    const child = utilityProcess.fork(fileURLToPath(new URL("./sidecar.js", import.meta.url)), [], {
      serviceName: "OpenCode Server",
      stdio: "inherit",
    })
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
      if (!error) return resolve(child)
      child.kill()
      reject(error)
    }
    const onMessage = (value: unknown) => {
      const message = value as SidecarMessage
      if (message.type === "diagnostic") diagnostic(message.message)
      if (message.type === "starting") diagnostic(message.stage)
      if (message.type === "ready") finish()
      if (message.type === "error")
        finish(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
    }
    const onExit = (code: number) => finish(new Error(`Embedded server exited during startup with code ${code}`))
    const timeout = setTimeout(() => finish(new Error("Embedded server startup timed out")), 30_000)
    child.on("message", onMessage)
    child.once("exit", onExit)
    child.once("spawn", () =>
      child.postMessage({
        type: "start",
        hostname: "127.0.0.1",
        port,
        password,
        userDataPath: app.getPath("userData"),
      }),
    )
  })
}

function stop(child: UtilityProcess) {
  if (!child.pid) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill()
      resolve()
    }, 5_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.postMessage({ type: "stop" })
  })
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address) return server.close(() => resolve(address.port))
      server.close(() => reject(new Error("Failed to allocate an embedded server port")))
    })
  })
}
