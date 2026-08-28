export * as DesktopPaths from "./paths"

import { Effect, Path } from "effect"

export interface Resolved {
  readonly developmentResourcesRoot: string
  readonly preloadRoot: string
  readonly preloadPath: string
  readonly rendererRoot: string
}

// Resolve from app.getAppPath(); a bundled module can live under out/main/chunks.
export const resolve = Effect.fn("DesktopPaths.resolve")(function* (root: string) {
  const path = yield* Path.Path
  const preloadRoot = path.join(root, "out/preload")
  return {
    developmentResourcesRoot: path.join(root, "resources"),
    preloadRoot,
    preloadPath: path.join(preloadRoot, "index.js"),
    rendererRoot: path.join(root, "out/renderer"),
  } satisfies Resolved
})
