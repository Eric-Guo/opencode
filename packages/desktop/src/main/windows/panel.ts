import { randomUUID } from "node:crypto"
import path from "node:path"
import { WebContentsView } from "electron"
import type { BrowserWindow } from "electron"
import { trackWebContents } from "./content"
import { wireNavigationPolicy } from "./security"
import { registerRendererProtocol } from "./protocol"

/** Bundled shell UI with its own session and no desktop RPC or credential injection. */
export function createPanel(
  win: BrowserWindow,
  options: {
    rendererRoot: string
    preloadRoot: string
    preload: string
    backgroundColor: string
    openExternal(url: string): void
  },
) {
  if (!/^[a-z0-9-]+$/.test(options.preload)) throw new Error("Invalid panel preload")

  const view = new WebContentsView({
    webPreferences: {
      partition: `desktop-panel-${randomUUID()}`,
      preload: path.join(options.preloadRoot, `${options.preload}.cjs`),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Protocol handlers belong to a session; a new partition cannot use the default session's handler.
  registerRendererProtocol(options.rendererRoot, view.webContents.session.protocol)
  trackWebContents(win, view.webContents)
  wireNavigationPolicy(view.webContents, options.openExternal)
  view.setBackgroundColor(options.backgroundColor)

  return view
}
