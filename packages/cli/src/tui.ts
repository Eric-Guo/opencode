import { NodeServices } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { Npm } from "@opencode-ai/util/npm"
import { AppProcess } from "@opencode-ai/util/process"
import { Effect, Option } from "effect"
import path from "node:path"
import { runDefault } from "./commands/handlers/default"
import { Config } from "./config"
import { configDirectory } from "./config-directory"
import { Updater } from "./services/updater"

export type V1TuiCommandInput = {
  readonly directory?: string
  readonly continue?: boolean
  readonly session?: string
  readonly standaloneCommand: ReadonlyArray<string>
}

export function runV1TuiBridge(input: V1TuiCommandInput) {
  const root = process.env.PWD ?? process.cwd()
  const directory = input.directory === undefined ? undefined : path.resolve(root, input.directory)
  return Effect.runPromise(
    runDefault(
      {
        directory: directory === undefined ? Option.none() : Option.some(directory),
        continue: input.continue ?? false,
        session: input.session === undefined ? Option.none() : Option.some(input.session),
        prompt: Option.none(),
        server: Option.none(),
        standalone: true,
        auto: false,
        yolo: false,
        dangerouslySkipPermissions: false,
      },
      { autoUpdate: false, standaloneCommand: input.standaloneCommand },
    ).pipe(
      Effect.provide(Config.layer),
      Effect.provide(Updater.layer),
      Effect.provide(
        LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node]), [
          [Global.node, Global.layerWith({ config: configDirectory() })],
        ]),
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
}
