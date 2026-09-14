import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import { Hash } from "@opencode/util/hash"

// Native module caches outlive Locations. Keep the latest evaluation and its
// fingerprints process-wide so recreating a Location reuses unchanged graphs.
const sources = new Map<string, Source>()

export function createPluginSources(watch: (file: string) => Promise<void>) {
  const subscribed = new Set<Source>()
  const watching = new Set<Promise<void>>()
  const watched = new Set<string>()
  let disposed = false
  const track = (file: string) => {
    if (watched.has(file)) return
    watched.add(file)
    const pending = watch(file).finally(() => watching.delete(pending))
    watching.add(pending)
    // Watch setup can be interrupted while module evaluation is still pending.
    void pending.catch(() => {})
  }
  return {
    read: async (entrypoint: string) => {
      await Promise.all(watching)
      if (disposed) throw new Error("Plugin sources have been disposed")
      const source = readSource(entrypoint)
      subscribed.add(source)
      source.listeners.add(track)
      for (const file of source.files.keys()) track(file)
      return source.loaded.finally(() => Promise.all(watching))
    },
    dispose: () => {
      disposed = true
      for (const source of subscribed) {
        source.listeners.delete(track)
        releaseSource(source)
      }
      subscribed.clear()
    },
  }
}

type Source = {
  entrypoint: string
  loaded: Promise<{ version: string; module: unknown }>
  files: Map<string, { digest: string; directory: boolean }>
  listeners: Set<(file: string) => void>
  pending: boolean
  dispose?: () => void
}

function readSource(entrypoint: string): Source {
  const previous = sources.get(entrypoint)
  if (previous && [...previous.files].every(([file, item]) => item.digest === digest(file, item.directory)))
    return previous

  const source: Source = {
    entrypoint,
    files: new Map(),
    listeners: new Set(),
    pending: true,
    // Publish the attempt before preparing or evaluating it, including failures.
    // Concurrent Locations must join the same native import.
    loaded: Promise.resolve()
      .then(async () => {
        const track = (file: string, directory = false) => {
          if (source.files.has(file)) return
          source.files.set(file, { digest: digest(file, directory), directory })
          for (const listener of source.listeners) listener(file)
        }
        track(fileURLToPath(entrypoint))
        const { prepareSource } = await import("#plugin-source")
        const prepared: { version: string; load: () => Promise<unknown>; dispose?: () => void } = await prepareSource(
          entrypoint,
          track,
        )
        source.dispose = prepared.dispose
        return prepared.load().then((module) => ({ version: prepared.version, module }))
      })
      .finally(() => {
        source.pending = false
        releaseSource(source)
      }),
  }
  sources.set(entrypoint, source)
  // Keep the current resolver alive for lazy imports after all Locations close.
  // Superseded graphs only need their resolver while a Location still uses them.
  if (previous) releaseSource(previous)
  return source
}

function releaseSource(source: Source) {
  if (source.pending || source.listeners.size > 0 || sources.get(source.entrypoint) === source) return
  source.dispose?.()
  source.dispose = undefined
}

function digest(file: string, directory: boolean) {
  try {
    return Hash.sha256(directory ? JSON.stringify(readdirSync(file).sort()) : readFileSync(file))
  } catch {
    return "missing"
  }
}

export function localSource(spec: string, directory: string) {
  if (spec.startsWith("file://")) return new URL(spec)
  if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec))
    return pathToFileURL(path.resolve(directory, spec))
  return undefined
}
