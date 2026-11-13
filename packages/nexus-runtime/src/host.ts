import { FileSystem } from "@opencode/core/filesystem"
import { Shell } from "@opencode/core/shell"
import { ShellResult } from "@opencode/core/shell/result"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath, PositiveInt } from "@opencode/schema/schema"
import { Effect } from "effect"

export function hostTools(locations: typeof LocationServiceMap.Service.Service) {
  return {
    shell(directory: string, command: string, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const result = yield* Effect.acquireUseRelease(
            shell.create({ command, cwd: directory, timeout: 30000 }),
            (started) => shell.wait(started.id).pipe(Effect.andThen(shell.result(started))),
            (started) => shell.stop(started.id, "killed").pipe(Effect.ignore),
          )
          const output = ShellResult.output(result)
          return {
            content: output.output,
            is_error: result.info.status !== "exited" || result.info.exit !== 0,
            structured_content: {
              truncated: output.truncated,
              exit: result.info.exit ?? null,
              status: result.info.status,
            },
          }
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    find(directory: string, query: string, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const files = yield* FileSystem.Service
          const rows = yield* files.find({ query, type: "file", limit: PositiveInt.make(100) })
          return rows.map((row) => row.path).join("\n")
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
  }
}
export type HostTools = ReturnType<typeof hostTools>
