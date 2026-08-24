export * as Wsl from "./start"

import { app } from "electron"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { Shutdown } from "../lifecycle/shutdown"
import { WslIpc } from "./ipc"

type WslCli = {
  readonly version: string
  readonly wslBuild?: { readonly script: string; readonly output: string }
}

export interface Interface extends WslIpc.Interface {
  readonly stop: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/Wsl") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cli = {
      version: process.env.OPENCODE_VERSION ?? app.getVersion(),
      wslBuild:
        app.isPackaged || !process.env.OPENCODE_DESKTOP_WSL_CLI_BUILD || !process.env.OPENCODE_DESKTOP_WSL_CLI_OUTPUT
          ? undefined
          : {
              script: process.env.OPENCODE_DESKTOP_WSL_CLI_BUILD,
              output: process.env.OPENCODE_DESKTOP_WSL_CLI_OUTPUT,
            },
    } satisfies WslCli
    const wsl = yield* makeWsl(cli)
    const shutdown = yield* Shutdown.Service
    const removeShutdown = yield* shutdown.add(wsl.stop)
    yield* Effect.addFinalizer(() => Effect.sync(removeShutdown).pipe(Effect.andThen(wsl.stop)))
    return Service.of(wsl)
  }),
)

const makeWsl = Effect.fn("Wsl.make")(function* (cli: WslCli) {
  if (process.platform !== "win32") return { ...WslIpc.create(), stop: Effect.void }

  const { createWslServersController } = yield* Effect.promise(() => import("./servers"))
  const { spawnWslSidecar } = yield* Effect.promise(() => import("./sidecar"))
  const { installWslCli, installWslDistro } = yield* Effect.promise(() => import("./runtime"))
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  const run = Effect.runPromiseWith(context)
  const runFork = Effect.runForkWith(context)
  const local = cli.wslBuild
  const controller = yield* createWslServersController({
    cli: { version: cli.version },
    installDistro: (distro) => run(installWslDistro(distro)),
    installCli: local
      ? async (distro) => {
          const { buildLocalWslCli } = await import("./local")
          await run(
            Effect.gen(function* () {
              const binary = yield* buildLocalWslCli({ ...local, version: cli.version })
              yield* installWslCli(distro, { version: cli.version, binary })
            }),
          )
        }
      : (distro, build) => run(installWslCli(distro, build)),
    spawnSidecar: (distro) => {
      runFork(Effect.logInfo("spawning wsl sidecar", { distro }))
      return spawnWslSidecar(distro, {
        onLine: (line) => runFork(Effect.logInfo("wsl sidecar", { distro, stream: line.stream, text: line.text })),
      })
    },
  })
  controller.startConfiguredServers()
  return {
    ...WslIpc.create(controller),
    stop: Effect.tryPromise(() => controller.stopServers()).pipe(Effect.orDie),
  } satisfies Interface
})
