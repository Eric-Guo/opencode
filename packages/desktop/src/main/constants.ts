import { existsSync } from "node:fs"
import path from "node:path"

import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = "opencode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_SERVERS_KEY = "wslServers"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"
export const UPDATER_CONFIG_PATH = path.join(process.resourcesPath, "app-update.yml")
export const UPDATER_ENABLED = app.isPackaged && existsSync(UPDATER_CONFIG_PATH)
