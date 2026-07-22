import { NodeServices } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { ServerProcess } from "@opencode-ai/server/process"
import { Effect } from "effect"
import { configDirectory } from "../config-directory"
import { OPENCODE_CHANNEL, OPENCODE_VERSION } from "../version"

export type Listener = {
  stop(close?: boolean): Promise<void>
}

export type ListenOptions = {
  hostname: string
  port: number
  password: string
  cors: string[]
}

export const Server = {
  listen(options: ListenOptions): Promise<Listener> {
    const controller = new AbortController()
    const ready = defer<void>()
    const state = { ready: false, stopping: false }
    const run = Effect.scoped(
      Effect.gen(function* () {
        yield* ServerProcess.start({
          app: {
            name: process.env.OPENCODE_CLIENT ?? "desktop",
            version: OPENCODE_VERSION,
            channel: OPENCODE_CHANNEL,
          },
          hostname: options.hostname,
          port: options.port,
          password: options.password,
          cors: options.cors,
          database: { path: process.env.OPENCODE_DB },
          models: {
            url: process.env.OPENCODE_MODELS_URL,
            file: process.env.OPENCODE_MODELS_PATH,
            fetch: !truthy(process.env.OPENCODE_DISABLE_MODELS_FETCH),
          },
          config: {
            directory: configDirectory(),
            project: !truthy(
              process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
            ),
            file: process.env.OPENCODE_CONFIG,
            content: process.env.OPENCODE_CONFIG_CONTENT,
          },
          windows: { gitbash: process.env.OPENCODE_GIT_BASH_PATH },
          fs: {
            filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
            fff:
              process.env.OPENCODE_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.OPENCODE_DISABLE_FFF),
          },
        })
        state.ready = true
        ready.resolve()
        return yield* Effect.never
      }),
    ).pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), [
          [Global.node, Global.layerWith({ config: configDirectory() })],
        ]),
      ),
      Effect.provide(NodeServices.layer),
    )
    const done = Effect.runPromise(run, { signal: controller.signal }).catch((error) => {
      if (state.stopping) return
      const failure = error instanceof Error ? error : new Error(String(error))
      if (!state.ready) return ready.reject(failure)
      console.error("desktop sidecar server failed", failure)
      setImmediate(() => process.exit(1))
    })
    return ready.promise.then(() => ({
      stop: async () => {
        state.stopping = true
        controller.abort()
        await done
      },
    }))
  },
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
