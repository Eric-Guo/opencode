import log from "electron-log/main.js"
import { createHandlePath } from "./disk"
import en from "./i18n/en"
import { createBrowserPane, type Pane } from "./pane"
import { createSystemMedia } from "./system-media"

export { Browser } from "@opencode/plugin-browser/rpc"

export { createRefs } from "./refs"

export { StoredBrowser } from "./restore"

export { createDesktopPane as createBrowserPane }

// The native Nexus host owns its tabs and storage and browses in an isolated partition.
function createDesktopPane(input: Omit<Parameters<typeof createBrowserPane>[0], "followAgentTabs" | "log" | "profile" | "t" | "sites" | "system" | "verifier">): Pane {
  const verifier = createHandlePath()
  const labels: Readonly<Record<string, string>> = en

  const pane = createBrowserPane({
    ...input,
    log: { write: (level, message, data) => log[level](message, data) },
    verifier,
    followAgentTabs: true,
    t: (key) => labels[key] ?? key,
    system: createSystemMedia(),
    sites: { get: () => "block", keep: () => undefined },
    emit(window, value) {
      const event = value.event

      // This host has no sign-in or permission prompt UI. Page dialogs remain available through browser.dialog.
      if (event.type === "prompt" && event.prompt && event.prompt.ask.kind !== "dialog") {
        void pane.answer(window, value.binding, event.tabID, event.prompt.id, { kind: "dismiss" })

        return
      }

      input.emit(window, value)
    },
  })

  return {
    ...pane,
    async dispose() {
      try {
        await pane.dispose()
      } finally {
        await verifier.close()
      }
    },
  }
}
