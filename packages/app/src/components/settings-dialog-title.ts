import { createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"

export function useSettingsDialogTitle() {
  const serverSync = useServerSync()
  const params = useParams()
  const config = createMemo(() => {
    const directory = decode64(params.dir) ?? serverSync.data.path.directory
    if (!directory) return serverSync.data.config
    return serverSync.child(directory)[0].config
  })

  return createMemo(() => {
    const name = config().username ?? serverSync.data.config.username ?? ""
    const current = config() as { clerk_code?: string }
    const global = serverSync.data.config as { clerk_code?: string }
    const clerk = current.clerk_code ?? global.clerk_code
    return clerk ? `${name} (${clerk})` : name
  })
}
