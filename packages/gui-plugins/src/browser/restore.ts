import { Browser } from "@opencode/plugin-browser/rpc"
import { Schema } from "effect"
import type { BuiltinMainStorage, MainStoreFrom } from "@opencode/plugin/gui/builtin"
import type { TabActivity } from "./policy"

export const StoredBrowser = Schema.Struct({
  // Who drove the tab, which keeps every agent-driven limit when it comes back: `control` says whether the person took
  // it over since.
  tabs: Schema.Array(Schema.Struct({
    id: Browser.TabID,
    url: Browser.Tab.fields.url,
    control: Schema.optionalKey(Schema.Literals(["agent", "reclaimed"])),
  })),
  focusedTabID: Schema.NullOr(Browser.TabID),
})

export type StoredBrowser = typeof StoredBrowser.Type

const empty: StoredBrowser = { tabs: [], focusedTabID: null }

export type BrowserRestore = {
  load(key: string): StoredBrowser
  save(key: string, state: StoredBrowser): void
  remove(key: string): void
}

/**
 * What the pane seeds its tabs' activity with from a saved state: a tab the agent drove stays agent-driven for good,
 * and stays the agent's until the person takes it over, though no command runs in it now.
 */
export function restoredActivity(saved: StoredBrowser) {
  return new Map<Browser.TabID, TabActivity>(
    saved.tabs.flatMap((tab) =>
      tab.control ? [[tab.id, { agentRuns: 0, control: tab.control }]] : [],
    ),
  )
}

/** Save the activity alongside each URL before handing the snapshot to the host's storage. */
export function savedBrowser(state: StoredBrowser, provenance: (tabID: Browser.TabID) => TabActivity | undefined): StoredBrowser {
  const tabs = state.tabs.map((tab) => {
    const control = provenance(tab.id)?.control

    return control ? { id: tab.id, url: tab.url, control } : { id: tab.id, url: tab.url }
  })

  return { tabs, focusedTabID: state.focusedTabID }
}

/** Tab URLs and focus per `${server}\n${session}`, imported once from the desktop's own `opencode.browser.dat` rows. */
export function createBrowserRestoreStore(storage: BuiltinMainStorage): BrowserRestore {
  const from = (key: string): MainStoreFrom => ({ state: ["opencode.browser.dat", key] })

  const open = (key: string) =>
    storage.store(`restore:${key}`, { schema: StoredBrowser, initial: empty, from: from(key) })

  const stores = new Map<string, ReturnType<typeof open>>()

  const store = (key: string) => {
    const existing = stores.get(key)

    if (existing) return existing
    const created = open(key)
    stores.set(key, created)

    return created
  }

  return {
    load: (key: string) => store(key).value,
    save(key, state) {
      const target = store(key)

      if (JSON.stringify(target.value) !== JSON.stringify(state)) target.set(state)
    },
    // Also drops the unimported desktop row, as the pane's own close always did.
    remove(key: string) {
      storage.remove(`restore:${key}`, { from: from(key) })
      stores.delete(key)
    },
  }
}
