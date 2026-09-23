import { createMemo, type Accessor } from "solid-js"
import type { ServerSync } from "@/runtime/server/sync"

// The settings dialog can open from routes without a ServerProvider (e.g. home),
// so the caller passes the resolved server sync in instead of using context.
export function useSettingsDialogTitle(
  serverSync: Accessor<ServerSync | undefined>,
  directory: Accessor<string | undefined>,
) {
  const config = createMemo(() => {
    const sync = serverSync()
    if (!sync) return
    const current = directory() ?? sync.data.path.directory
    if (!current) return sync.data.config
    return sync.child(current)[0].config
  })

  return createMemo(() => {
    const sync = serverSync()
    if (!sync) return ""
    const name = config()?.username ?? sync.data.config.username ?? ""
    const clerk = config()?.clerk_code ?? sync.data.config.clerk_code
    return clerk ? `${name} (${clerk})` : name
  })
}
