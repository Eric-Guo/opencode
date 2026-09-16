export * as ConfigWatch from "./watch.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import type { Watcher } from "../filesystem/watcher.js"
import type { ConfigDiscovery } from "./discovery.js"

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
    ...(sources.user && userPresent ? [sources.user] : []),
    ...(sources.global ? [sources.global] : []),
    ...sources.project.filter((root) => root.present).map((root) => root.path),
  ]
  const files = [
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
        ignore: ["node_modules", ".git", "**/{node_modules,.git}/**"],
      })),
      ...Array.from(parents, ([parent, files]) => ({
        path: parent,
        type: "entries" as const,
        names: [...new Set(files.map((file) => path.basename(file)))].toSorted(),
      })),
    ].map((target) => [JSON.stringify(target), target satisfies Watcher.WatchInput]),
  )
})
