export * as ConfigWatch from "./watch.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import type { Watcher } from "../filesystem/watcher.js"
import { ConfigDiscovery } from "./discovery.js"

// Case-insensitive everywhere: macOS volumes usually are too, and a false match only costs a reload.
function key(file: string) {
  return path.normalize(file).toLowerCase()
}

/** Paths whose content or presence feeds the loaded config; other writes under watched roots do not. */
export const inputs = Effect.fnUntraced(function* (sources: ConfigDiscovery.Sources, references: Set<string>) {
  const fs = yield* FSUtil.Service
  const real = yield* Effect.forEach(references, (file) => fs.realPath(file).pipe(Effect.orElseSucceed(() => file)), {
    concurrency: "unbounded",
  })
  const roots = [
    ...(sources.user ? [sources.user] : []),
    ...(sources.system ? [sources.system.path] : []),
    ...(sources.global ? [sources.global] : []),
    ...sources.project.map((root) => root.path),
  ]
  const paths = new Set(
    [
      ...roots,
      ...roots.flatMap((root) => ConfigDiscovery.names.map((name) => path.join(root, name))),
      ...sources.direct,
      ...sources.claude,
      ...sources.agents,
      ...(sources.explicit ? [sources.explicit] : []),
      ...references,
      ...real,
    ].map(key),
  )
  const user = sources.user && key(sources.user)
  return (file: string) => paths.has(key(file)) || (user !== undefined && FSUtil.contains(key(file), user))
})

export const plan = Effect.fn("ConfigWatch.plan")(function* (sources: ConfigDiscovery.Sources) {
  const fs = yield* FSUtil.Service
  const userPresent = sources.user ? yield* fs.isDir(sources.user) : false
  // A recursive watch cannot attach to a missing root. Follow its nearest
  // existing ancestor until creation lets reconciliation watch the root itself.
  let userEntry: string | undefined = sources.user
  while (userEntry && !(yield* fs.isDir(path.dirname(userEntry)))) {
    const parent = path.dirname(userEntry)
    if (parent === userEntry) break
    userEntry = parent
  }
  const directories = [
    ...(sources.system?.present ? [sources.system.path] : []),
    ...(sources.user && userPresent ? [sources.user] : []),
    ...(sources.global ? [sources.global] : []),
    ...sources.project.filter((root) => root.present).map((root) => root.path),
  ]
  const files = [
    ...(sources.system ? [sources.system.path] : []),
    ...(userEntry ? [userEntry] : []),
    ...sources.direct,
    ...sources.project.map((root) => root.path),
    ...sources.claude,
    ...sources.agents,
    ...(sources.explicit ? [sources.explicit] : []),
  ]
  // Keep a parent watch for each root so deletion/recreation is observable.
  const parents = Map.groupBy(
    files.filter((file) => !directories.some((directory) => file !== directory && FSUtil.contains(directory, file))),
    (file) => path.dirname(file),
  )
  return new Map(
    [
      ...directories.map((path) => ({
        path,
        type: "directory" as const,
        ignore: FSUtil.ignoreGlobs,
      })),
      ...Array.from(parents, ([parent, files]) => ({
        path: parent,
        type: "entries" as const,
        names: [...new Set(files.map((file) => path.basename(file)))].toSorted(),
      })),
    ].map((target) => [JSON.stringify(target), target satisfies Watcher.WatchInput]),
  )
})
