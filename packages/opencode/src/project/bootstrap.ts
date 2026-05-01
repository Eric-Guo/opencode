import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Plugin } from "../plugin"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { FileWatcher } from "@/file/watcher"
import { ShareNext } from "@/share/share-next"
import * as Effect from "effect/Effect"
import { Config } from "@/config/config"

export const InstanceBootstrap = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  Log.Default.info("bootstrapping", { directory: ctx.directory })
  yield* Effect.all(
    [
      Config.Service.use((i) => i.get()),
      ...[
        Plugin.Service,
        LSP.Service,
        ShareNext.Service,
        Format.Service,
        File.Service,
        FileWatcher.Service,
        Vcs.Service,
        Snapshot.Service,
      ].map((s) => s.use((i) => i.init())),
    ].map((e) => Effect.forkDetach(e)),
  ).pipe(Effect.withSpan("InstanceBootstrap.init"))

  const projectID = ctx.project.id
  yield* Bus.Service.use((svc) =>
    svc.subscribeCallback(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        Project.setInitialized(projectID)
      }
    }),
  )
}).pipe(Effect.withSpan("InstanceBootstrap"))
