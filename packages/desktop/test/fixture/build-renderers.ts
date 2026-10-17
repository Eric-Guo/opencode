import { loadConfigFromFile, PreloadConfigFactory, RendererConfigFactory } from "electron-vite"
import { build } from "vite"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")

const config = await loadConfigFromFile(
  { command: "build", mode: "production" },
  join(root, "electron.vite.config.ts"),
  root,
  "silent",
)

if (!config.config.preload) throw new Error("Desktop preload configuration is missing")

if (!config.config.renderer) throw new Error("Desktop renderer configuration is missing")

if (!process.argv[2]) throw new Error("Renderer fixture output is required")

config.config.preload.build = { ...config.config.preload.build, outDir: process.argv[2], emptyOutDir: false }

await build(await new PreloadConfigFactory(config.config.preload, { envDir: false }, { root }).build())

config.config.renderer.build = {
  ...config.config.renderer.build,
  outDir: join(process.argv[2], "renderer"),
  emptyOutDir: false,
}

await build(await new RendererConfigFactory(config.config.renderer, { envDir: false }, { root }).build())
