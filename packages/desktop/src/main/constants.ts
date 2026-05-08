import { existsSync } from "node:fs"
import path from "node:path"

import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

export const UPDATER_CONFIG_PATH = path.join(process.resourcesPath, "app-update.yml")
export const UPDATER_ENABLED = app.isPackaged && existsSync(UPDATER_CONFIG_PATH)

const appNames: Record<string, string> = {
  dev: "SigmaAgents",
  beta: "SigmaAgents",
  prod: "SigmaAgents",
}
const appIDs: Record<string, string> = {
  dev: "ai.opencode.desktop",
  beta: "ai.opencode.desktop",
  prod: "ai.opencode.desktop",
}
// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "SigmaAgents"
export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "ai.opencode.desktop.dev"
