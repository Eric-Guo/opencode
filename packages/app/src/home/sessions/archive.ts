import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import type { ServerConnection } from "@/runtime/server/registry"
import type { SessionInfo } from "@opencode/client/promise"

type HomeSession = Pick<SessionInfo, "id" | "location">

export async function archiveHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  archive: (sessionID: string) => Promise<void>
  remove: () => void
  onError?: (cause: unknown) => void
}) {
  await input
    .archive(input.session.id)
    .then(() => {
      input.remove()
      notifySessionTabsRemoved({
        server: input.server,
        directory: input.session.location.directory,
        sessionIDs: [input.session.id],
      })
    })
    .catch((error) => input.onError?.(error))
}
