import { posix, win32 } from "node:path"

const PREFIX = "opencode2-v"

export function cliInstallDirectory(userDataPath: string, platform: NodeJS.Platform = process.platform) {
  return (platform === "win32" ? win32 : posix).join(userDataPath, "cli")
}

export function cliInstallPath(userDataPath: string, version: string, platform: NodeJS.Platform = process.platform) {
  const root = cliInstallDirectory(userDataPath, platform)
  const name = PREFIX + version.replace(/[^a-zA-Z0-9._-]/g, "-")

  if (platform === "win32") return win32.join(root, `${name}.exe`)

  return posix.join(root, name)
}

export function isCliInstallName(name: string) {
  return name.startsWith(PREFIX) && !name.endsWith(".tmp") && (process.platform !== "win32" || name.endsWith(".exe"))
}
