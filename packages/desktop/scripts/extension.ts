import { Schema } from "effect"
import { existsSync, readFileSync, statSync } from "node:fs"
import { cp, mkdir, readdir, readFile } from "node:fs/promises"
import { resolve, join, dirname, relative } from "node:path"
import type { Plugin } from "vite"

type Manifest = {
  apiVersion: 1
  main: string
  renderer: string
  preload: string
  preloads: Record<string, string>
  assets: Record<string, string>
  builds?: Record<string, string>
  rendererConfig?: string
}

export function readDesktopExtension(root = process.env.OPENCODE_DESKTOP_EXTENSION) {
  if (!root || root === "none") return undefined
  const directory = resolve(root)
  const manifest: unknown = JSON.parse(readFileSync(join(directory, "desktop-extension.json"), "utf8"))

  if (!isManifest(manifest)) throw new Error("Invalid desktop extension manifest")

  return { directory, manifest }
}

/** Build-time opt-in: no extension checkout or dependencies are required for the base desktop. */
export function desktopExtension(root = process.env.OPENCODE_DESKTOP_EXTENSION) {
  const config = readDesktopExtension(root)

  if (!config) return undefined
  const directory = config.directory
  const manifest = config.manifest

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

  const copyAssets = async (output = resolve("out/renderer")) => {
    await Promise.all(
      assets.map(async (asset) => {
        const destination = resolve(output, asset.name)
        await mkdir(dirname(destination), { recursive: true })
        await cp(asset.path, destination, { recursive: true })
      }),
    )
  }

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
    async writeBundle(options) {
      const output = resolve(options.dir ?? "out/renderer")

      // Shared content-hashed assets can overlap, but must never replace a different host asset.
      for (const asset of assets) {
        const files = asset.directory
          ? (await readdir(asset.path, { recursive: true, withFileTypes: true }))
              .filter((entry) => entry.isFile())
              .map((entry) => join(entry.parentPath, entry.name))
          : [asset.path]

        await Promise.all(
          files.map(async (source) => {
            const name = join(asset.name, asset.directory ? relative(asset.path, source) : "")
            const destination = resolve(output, name)

            if (!existsSync(destination)) return

            const [original, incoming] = await Promise.all([readFile(destination), readFile(source)])

            if (!original.equals(incoming)) throw new Error(`Conflicting desktop extension asset: ${name}`)
          }),
        )
      }

      await copyAssets(output)
    },
  }

  return {
    main: file(manifest.main),
    renderer: file(manifest.renderer),
    rendererConfig: manifest.rendererConfig ? file(manifest.rendererConfig) : undefined,
    preload: file(manifest.preload),
    preloads: Object.fromEntries(Object.entries(manifest.preloads).map(([name, path]) => [name, file(path)])),
    assetsPlugin,
    copyAssets,
  }
}

const ManifestSchema = Schema.Struct({
  apiVersion: Schema.Literal(1),
  main: Schema.String,
  renderer: Schema.String,
  preload: Schema.String,
  preloads: Schema.Record(Schema.String, Schema.String),
  assets: Schema.Record(Schema.String, Schema.String),
  builds: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  rendererConfig: Schema.optionalKey(Schema.String),
})

const isManifest = Schema.is(ManifestSchema)
