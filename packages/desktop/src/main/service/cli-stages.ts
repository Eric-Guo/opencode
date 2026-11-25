import { Effect, FileSystem, Path } from "effect"
import { isCliInstallName } from "../cli-install"

// Packaged builds stage files in the CLI directory. Isolated builds stage each copy in its own subdirectory.
// Windows refuses to delete a running executable, so a failed removal is logged and retried on the next launch.
export const cleanStages = Effect.fn("DesktopCli.cleanStages")(function* (
  binary: string,
  options: { readonly root: string; readonly keep?: ReadonlyArray<string> },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.dirname(binary)
  const flat = directory === options.root

  if (!flat && path.dirname(directory) !== options.root) return

  const executable = path.basename(binary)
  const keep = new Set([flat ? executable : path.basename(directory), ...(options.keep ?? [])])
  const entries = yield* fs.readDirectory(options.root)

  yield* Effect.forEach(
    entries,
    Effect.fnUntraced(function* (entry) {
      if (keep.has(entry) || (flat && !isCliInstallName(entry))) return

      const target = path.join(options.root, entry)
      const stat = yield* fs
        .stat(flat ? target : path.join(target, executable))
        .pipe(Effect.orElseSucceed(() => undefined))

      if (stat?.type !== "File") return

      yield* fs
        .remove(target, { recursive: !flat, force: true })
        .pipe(Effect.catch((error) => Effect.logError("failed to clean staged v2 CLI", { path: target, error })))
    }),
    { concurrency: "unbounded" },
  )
})
