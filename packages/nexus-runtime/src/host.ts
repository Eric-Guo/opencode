import { Ripgrep } from "@opencode/core/ripgrep"
import { Snapshot } from "@opencode/core/snapshot"
import { Mcp } from "@opencode/core/mcp/index"
import { Pty } from "@opencode/core/pty"
import { FileSystem } from "@opencode/core/filesystem"
import { Shell } from "@opencode/core/shell"
import { ShellResult } from "@opencode/core/shell/result"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath, PositiveInt } from "@opencode/schema/schema"
import { Effect } from "effect"

export function hostTools(locations: typeof LocationServiceMap.Service.Service) {
  return {
    capture(directory: string, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          return yield* snapshot.capture()
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    changes(directory: string, before: string, after: string, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          return yield* snapshot.diff({ from: Snapshot.ID.make(before), to: Snapshot.ID.make(after) })
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    restoreTree(
      directory: string,
      before: string,
      after: string,
      current: string,
      signal: AbortSignal,
      pathsFrom?: string,
      pathsTo?: string,
    ) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const from = Snapshot.ID.make(before)
          const to = Snapshot.ID.make(after)
          const paths = yield* snapshot.files({
            from: Snapshot.ID.make(pathsFrom ?? before),
            to: Snapshot.ID.make(pathsTo ?? after),
          })
          const later = yield* snapshot.files({ from: to, to: Snapshot.ID.make(current) })
          if (paths.some((path) => later.includes(path)))
            return yield* Effect.fail(new Error("Files have changed since this checkpoint."))
          return yield* snapshot.restore({ files: new Map(paths.map((path) => [path, from])) })
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    mcp(directory: string) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const mcp = yield* Mcp.Service
          return mcp
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
      )
    },
    pty(directory: string) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const pty = yield* Pty.Service
          return pty
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
      )
    },
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
    grep(directory: string, pattern: string, include: string | undefined, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const ripgrep = yield* Ripgrep.Service
          const matches = yield* ripgrep.grep({ cwd: directory, pattern, include, limit: 100, signal })
          return matches
            .map((match) => match.entry.path + ":" + match.line + ": " + match.text.trimEnd())
            .join("\n")
            .slice(0, 65536)
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
