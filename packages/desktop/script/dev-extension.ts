import { buildExtension } from "./build-extension"
import { desktopExtension } from "./extension"
import { resolve } from "node:path"

export async function prepareDevExtension(root = process.env.OPENCODE_DESKTOP_EXTENSION, output?: string) {
  const directory = await buildExtension(root)

  if (!directory) return

  if (desktopExtension(directory)!.rendererConfig) {
    const { RendererConfigFactory } = await import("electron-vite")
    const { build } = await import("vite")
    const { createDesktopConfig } = await import("../electron.vite.config")
    const config = await createDesktopConfig({ command: "build", mode: "production" }, directory)

    await build(
      await new RendererConfigFactory(
        config.renderer,
        { configFile: false, build: { outDir: output } },
        {
          root: resolve(import.meta.dir, ".."),
        },
      ).build(),
    )

    return
  }

  // Local tabs without a dev URL load out/renderer even while the primary renderer uses Vite.
  await desktopExtension(directory)!.copyAssets(output)
}
