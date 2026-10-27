import { resolve } from "node:path"
import { readDesktopExtension } from "./extension"

export async function buildExtension(root = process.env.OPENCODE_DESKTOP_EXTENSION) {
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

  return config.directory
}
