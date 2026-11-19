import { describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Layer, Option } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Shell } from "@opencode/core/shell"
import { ToolOutput } from "@opencode/core/tool-output"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { hostEnvironmentLayer } from "./fixture/environment"
import { location } from "./fixture/location"
import { disabledPersistentPtyLayer } from "./fixture/persistent-pty"
import { withTempDir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const withStore = <A, E, R>(body: (fs: FSUtil.Interface, root: string) => Effect.Effect<A, E, R>) =>
  withTempDir((tmp) => {
    const layer = AppNodeBuilder.build(LayerNode.group([FSUtil.node, Global.node, PersistentPty.node]), [
      Global.node.replace(Global.layerWith({ data: tmp.path })),
      PersistentPty.node.replace(disabledPersistentPtyLayer),
    ])
    return Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* body(fs, tmp.path)
    }).pipe(Effect.provide(layer))
  })

describe("Shell cleanup", () => {
  it.live("runs the shared output sweeps outside the Location that starts them", () =>
    withStore((fs, root) =>
      Effect.gen(function* () {
        const shell = yield* Deferred.make<boolean>()
        const tool = yield* Deferred.make<boolean>()
        const recordLocation = (observed: Deferred.Deferred<boolean>) =>
          Effect.serviceOption(Location.Service).pipe(
            Effect.flatMap((value) => Deferred.succeed(observed, Option.isSome(value))),
          )
        const caller = location({ directory: AbsolutePath.make(root) })
        const layer = AppNodeBuilder.build(LayerNode.group([Location.node, Shell.node, ToolOutput.node]), [
          Location.node.replace(Layer.succeed(Location.Service, caller)),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(hostEnvironmentLayer),
          Global.node.replace(Global.layerWith({ data: root })),
          PersistentPty.node.replace(disabledPersistentPtyLayer),
          FSUtil.node.replace(
            Layer.succeed(FSUtil.Service, {
              ...fs,
              readDirectory: (directory) =>
                directory === path.join(root, ToolOutput.DIRECTORY)
                  ? recordLocation(tool).pipe(Effect.andThen(fs.readDirectory(directory)))
                  : fs.readDirectory(directory),
              readDirectoryEntries: (directory) =>
                directory === path.join(root, Shell.DIRECTORY)
                  ? recordLocation(shell).pipe(Effect.andThen(fs.readDirectoryEntries(directory)))
                  : fs.readDirectoryEntries(directory),
            }),
          ),
        ])
        yield* Layer.build(layer)
        expect(yield* Deferred.await(shell)).toBe(false)
        expect(yield* Deferred.await(tool)).toBe(false)
      }),
    ),
  )

  it.live("removes expired output files across projects", () =>
    withStore((fs, root) =>
      Effect.gen(function* () {
        const first = path.join(root, Shell.DIRECTORY, "first")
        const second = path.join(root, Shell.DIRECTORY, "second")
        const old = path.join(first, "sh_0123456789abABCDEFGHIJKLMN.out")
        const recent = path.join(second, "sh_0123456789abNOPQRSTUVWXYZ0.out")
        const unrelated = path.join(first, "notes.out")
        yield* fs.ensureDir(first)
        yield* fs.ensureDir(second)
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "unrelated")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, new Date(), expired)
        yield* fs.utimes(unrelated, new Date(), expired)

        yield* Shell.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
