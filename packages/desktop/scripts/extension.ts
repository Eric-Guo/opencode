import { existsSync, readFileSync, statSync } from "node:fs"
import { cp, mkdir } from "node:fs/promises"
import { resolve, join, dirname } from "node:path"
import type { Plugin } from "vite"

type Manifest = {
  apiVersion: 1
  main: string
  renderer: string
  preload: string
  preloads: Record<string, string>
  assets: Record<string, string>
}

/** Build-time opt-in: no extension checkout or dependencies are required for the base desktop. */
export function desktopExtension(root = process.env.OPENCODE_DESKTOP_EXTENSION) {
  if (!root || root === "none") return undefined
  const directory = resolve(root)
  const manifest: unknown = JSON.parse(readFileSync(join(directory, "desktop-extension.json"), "utf8"))
  if (!isManifest(manifest)) throw new Error("Invalid desktop extension manifest")
  const file = (value: string) => {
    const path = resolve(directory, value)
    if (!existsSync(path)) throw new Error(`Desktop extension entry is missing: ${path}`)
    return path
  }
  const assets = Object.entries(manifest.assets).map(([name, value]) => {
    if (name.startsWith("/") || name.split(/[\\/]/).includes("..")) throw new Error("Invalid extension asset path")
    const path = file(value)
    return { name, path, directory: statSync(path).isDirectory() }
  })
  const assetsPlugin: Plugin = {
    name: "opencode:extension-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const asset = assets.find((asset) => !asset.directory && request.url?.split("?")[0] === `/${asset.name}`)
        if (!asset) return next()
        if (asset.name.endsWith(".html")) response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(readFileSync(asset.path))
      })
    },
    async writeBundle() {
      await Promise.all(
        assets.map(async (asset) => {
          const destination = resolve("out/renderer", asset.name)
          await mkdir(dirname(destination), { recursive: true })
          await cp(asset.path, destination, { recursive: true })
        }),
      )
    },
  }
  return {
    main: file(manifest.main),
    renderer: file(manifest.renderer),
    preload: file(manifest.preload),
    preloads: Object.fromEntries(Object.entries(manifest.preloads).map(([name, path]) => [name, file(path)])),
    assetsPlugin,
  }
}

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.apiVersion === 1 &&
    typeof record.main === "string" &&
    typeof record.renderer === "string" &&
    typeof record.preload === "string" &&
    isPaths(record.preloads) &&
    isPaths(record.assets)
  )
}
function isPaths(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((path) => typeof path === "string")
  )
}
