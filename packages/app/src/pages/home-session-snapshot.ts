import type { Session, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { trimSessions } from "@/context/global-sync/session-trim"
import { pathKey } from "@/utils/path-key"

export const HOME_V2_SESSION_LIMIT = 5_000

export class HomeSessionSnapshotUnsupported extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HomeSessionSnapshotUnsupported"
  }
}

export async function loadHomeSessionSnapshot(
  list: (input: { limit: number; order: "desc" }) => Promise<{ data?: unknown }>,
) {
  const response = await list({ limit: HOME_V2_SESSION_LIMIT, order: "desc" })
  return parseHomeSessionSnapshot(response.data)
}

// TODO(v2): Once the released V2 server supports project.list plus root-only,
// updated-time session listing, replace this full-table compatibility adapter
// and remove its synthetic legacy fields, client filtering, and 5,000-row guard.
export function parseHomeSessionSnapshot(value: unknown): Session[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new HomeSessionSnapshotUnsupported("Invalid V2 response")
  if (value.data.length >= HOME_V2_SESSION_LIMIT)
    throw new HomeSessionSnapshotUnsupported("V2 session snapshot exceeded the safe single-page limit")

  const seen = new Map<string, string>()
  return value.data.flatMap((item) => {
    if (!isV2Session(item)) throw new HomeSessionSnapshotUnsupported("Invalid V2 session")
    const directory = item.location.directory
    const previous = seen.get(item.id)
    if (previous !== undefined && pathKey(previous) !== pathKey(directory))
      throw new HomeSessionSnapshotUnsupported("Conflicting V2 session directories")
    seen.set(item.id, directory)
    if (item.parentID || item.time.archived !== undefined) return []
    return [toLegacySummary(item)]
  })
}

export function retainHomeSessions(sessions: Session[], limit: number, now: number) {
  const grouped = Map.groupBy(sessions, (session) => pathKey(session.directory))
  return [...grouped.values()].flatMap((items) => trimSessions(items, { limit, permission: {}, now }))
}

export function applyHomeSessionEvent(sessions: Session[], event: { type: string; properties?: unknown }) {
  if (!isRecord(event.properties) || !isLegacySummary(event.properties.info)) return sessions
  const info = event.properties.info
  const index = sessions.findIndex((session) => session.id === info.id)
  if (event.type === "session.deleted" || info.parentID || info.time.archived !== undefined) {
    if (index === -1) return sessions
    return sessions.toSpliced(index, 1)
  }
  if (event.type !== "session.created" && event.type !== "session.updated") return sessions
  if (index === -1) return [...sessions, info]
  return sessions.with(index, info)
}

function toLegacySummary(session: SessionV2Info): Session {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    workspaceID: session.location.workspaceID,
    directory: session.location.directory,
    path: session.subpath,
    parentID: session.parentID,
    cost: session.cost,
    tokens: session.tokens,
    title: session.title,
    agent: session.agent,
    model: session.model,
    version: "",
    time: session.time,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isV2Session(value: unknown): value is SessionV2Info {
  if (!isRecord(value) || !isRecord(value.location) || !isRecord(value.time)) return false
  return (
    typeof value.id === "string" &&
    typeof value.projectID === "string" &&
    typeof value.title === "string" &&
    typeof value.location.directory === "string" &&
    typeof value.time.created === "number" &&
    typeof value.time.updated === "number"
  )
}

function isLegacySummary(value: unknown): value is Session {
  if (!isRecord(value) || !isRecord(value.time)) return false
  return (
    typeof value.id === "string" &&
    typeof value.directory === "string" &&
    typeof value.projectID === "string" &&
    typeof value.title === "string" &&
    typeof value.time.created === "number" &&
    typeof value.time.updated === "number"
  )
}
