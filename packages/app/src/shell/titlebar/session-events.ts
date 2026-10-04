import { Option, Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { ServerConnection } from "@/runtime/server/registry"

export const SESSION_TABS_REMOVED_EVENT = "opencode:session-tabs-removed"

export type SessionTabsRemovedDetail = {
  server: ServerConnection.Key
  directory: string
  sessionIDs: string[]
}

export function notifySessionTabsRemoved(input: SessionTabsRemovedDetail) {
  window.dispatchEvent(new CustomEvent(SESSION_TABS_REMOVED_EVENT, { detail: input }))
}

export function readSessionTabsRemovedDetail(event: Event): SessionTabsRemovedDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  return Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.Struct({
        server: ServerConnection.Key,
        directory: Schema.String,
        sessionIDs: Persistence.array(Schema.String).check(Schema.isMinLength(1)),
      }),
    )(event.detail),
  )
}
