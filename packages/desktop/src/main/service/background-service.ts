import { app } from "electron"
import { Context, Effect, Exit, Layer, Path } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ServerReadyData } from "../../shared/ipc-contract"
import { loadDesktopTabs } from "../desktop-tabs"
import { cleanStages, DesktopCli } from "./desktop-cli"

export * as BackgroundService from "./background-service"

export interface Interface {
  readonly connection: Effect.Effect<ServerReadyData>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BackgroundService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const result = yield* start().pipe(Effect.exit)
    return Service.of({
      connection: Exit.isSuccess(result)
        ? Effect.succeed(result.value)
        : Effect.failCause(result.cause).pipe(Effect.orDie),
    })
  }),
)

const start = Effect.fn("BackgroundService.start")(function* () {
  yield* Effect.logInfo("starting v2 background service")
  const path = yield* Path.Path
  const desktopCli = yield* DesktopCli.Service
  const runFork = Effect.runForkWith(yield* Effect.context())
  const isolated = !app.isPackaged && process.env.OPENCODE_DESKTOP_ISOLATED_SERVER === "1"
  const cli = yield* desktopCli.resolve
  if (isolated) process.env.XDG_STATE_HOME = app.getPath("userData")
  const cors = loadDesktopTabs().flatMap((tab) => ("url" in tab && tab.localServer ? [new URL(tab.url).origin] : []))
  const command = [...cli.command, "service", "set", "cors", JSON.stringify(cors)]
  const file = command[0]
  if (!file) return yield* Effect.die("V2 CLI command is empty")
  yield* Effect.logInfo("v2 CLI command started", { command })
  const configured = yield* Effect.tryPromise(async () => {
    const result = await promisify(execFile)(file, command.slice(1))
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  })
  yield* Effect.logInfo("v2 CLI command completed", { command, ...configured })
  const client = yield* Effect.promise(() => import("@opencode-ai/client/service"))
  const service = yield* Effect.tryPromise(() =>
    client.Service.ensure({
      file:
        isolated && process.env.OPENCODE_DESKTOP_SERVER_CHANNEL === "local"
          ? path.join(app.getPath("userData"), "opencode", "service-local.json")
          : undefined,
      version: cli.version,
      command: [...cli.command, "serve", "--service", ...(isolated ? ["--port", "0"] : [])],
      onStart: (reason, previousVersion) =>
        runFork(Effect.logInfo("v2 CLI background service starting", { reason, previousVersion })),
    }),
  )
  if (service.auth?.type !== "basic") throw new Error("V2 CLI background service did not provide authentication")
  const url = new URL(service.url)
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
  yield* Effect.logInfo("v2 CLI background service ready", {
    username: service.auth.username,
    OPENCODE_SERVER_PASSWORD: service.auth.password,
    version: cli.version,
    ...endpoint(url.origin),
  })
  if (isolated && cli.binary) yield* cleanStages(cli.binary).pipe(Effect.orDie)
  return {
    url: url.origin,
    username: service.auth.username,
    password: service.auth.password,
    ...(process.env.THAPE_SSO_BEARER_API_KEY
      ? { ssoJwtSecretKey: process.env.THAPE_SSO_BEARER_API_KEY }
      : {}),
  } satisfies ServerReadyData
})

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)
  return { url, hostname: parsed.hostname, port: parsed.port }
}
