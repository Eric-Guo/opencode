import { buildExtension } from "./build-extension"
import { desktopExtension } from "./extension"

export async function prepareDevExtension(root = process.env.OPENCODE_DESKTOP_EXTENSION, output?: string) {
  const directory = await buildExtension(root)

  if (!directory) return

  // Local tabs without a dev URL load out/renderer even while the primary renderer uses Vite.
  await desktopExtension(directory)!.copyAssets(output)
}
