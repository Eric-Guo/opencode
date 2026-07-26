import { createMemo, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"
import type { ServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"

// The settings dialog can open from routes without a ServerProvider (e.g. home),
// so the caller passes the resolved server sync in instead of using context.
export function useSettingsDialogTitle(serverSync: Accessor<ServerSync | undefined>) {
  const params = useParams()
  const config = createMemo(() => {
    const sync = serverSync()
    if (!sync) return
    const directory = decode64(params.dir) ?? sync.data.path.directory
    if (!directory) return sync.data.config
    return sync.child(directory)[0].config
  })

  return createMemo(() => {
    const sync = serverSync()
    if (!sync) return ""
    const name = config()?.username ?? sync.data.config.username ?? ""
    const current = config() as { clerk_code?: string } | undefined
    const global = sync.data.config as { clerk_code?: string }
    const clerk = current?.clerk_code ?? global.clerk_code
    return clerk ? `${name} (${clerk})` : name
  })
}
