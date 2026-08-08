import { join, win32 } from "node:path"

export function cliInstallPath(userDataPath: string, version: string, platform: NodeJS.Platform = process.platform) {
  const name = `opencode2-v${version.replace(/[^a-zA-Z0-9._-]/g, "-")}`
  if (platform === "win32") return win32.join(userDataPath, "cli", `${name}.exe`)
  return join(userDataPath, "cli", name)
}
