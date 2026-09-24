import { resolve } from "node:path"
import { desktopExtension, readDesktopExtension } from "./extension"

export async function prepareDevExtension(root = process.env.OPENCODE_DESKTOP_EXTENSION, output?: string) {
  const config = readDesktopExtension(root)
  if (!config) return
  for (const [project, script] of Object.entries(config.manifest.builds ?? {})) {
    const code = await Bun.spawn([process.execPath, "run", script], {
      cwd: resolve(config.directory, project),
      env: process.env,
      stdio: ["inherit", "inherit", "inherit"],
    }).exited
    if (code) throw new Error(`Desktop extension build failed: ${project} (${code})`)
  }
  // Local tabs without a dev URL load out/renderer even while the primary renderer uses Vite.
  await desktopExtension(config.directory)!.copyAssets(output)
}
