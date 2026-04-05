import path from "node:path"

export type Channel = "local" | "dev" | "beta" | "prod"

// Unpackaged dev runs keep the dev profile directory (`appID`), but use a separate Windows
// AppUserModelID: Electron writes a Start Menu `Electron.lnk` with the active AUMID on the first
// toast, which would otherwise shadow the installed OpenCode Dev shortcut and route its toast
// clicks to bare `electron.exe`.
const LOCAL_APP_USER_MODEL_ID = "ai.opencode.desktop.local"

export function resolveIdentity(channel: Channel, packaged: boolean) {
  const installedID = channel === "beta" ? "ai.opencode.desktop.beta" : "ai.opencode.desktop"

  return {
    appName: "SigmaAgents",
    appID: packaged ? "ai.opencode.desktop" : "ai.opencode.desktop.dev",
    appUserModelID: packaged ? installedID : LOCAL_APP_USER_MODEL_ID,
  }
}

export function isCollidingDevShortcut(
  shortcut: { readonly appUserModelId?: string; readonly target: string },
  appUserModelID: string,
  execPath: string,
) {
  if (!shortcut.appUserModelId) return false

  if (shortcut.appUserModelId.toLowerCase() !== appUserModelID.toLowerCase()) return false

  return path.win32.normalize(shortcut.target).toLowerCase() !== path.win32.normalize(execPath).toLowerCase()
}
