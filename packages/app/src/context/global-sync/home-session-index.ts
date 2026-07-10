import type { Session, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { trimSessions } from "./session-trim"
import { pathKey } from "@/utils/path-key"

export const HOME_V2_SESSION_PAGE_LIMIT = 5_000

export type HomeSessionEvent = { type: string; properties?: unknown }
export type HomeSessionEvents = {
  sequence: number
  entries: Array<{ sequence: number; event: HomeSessionEvent }>
}
export type HomeSessionIndex = {
  sessions: Session[]
  eventSequence: number
}

export const homeSessionIndexKey = (server: string) => ["home", "session-index", server] as const
export const homeSessionEventsKey = (server: string) => ["home", "session-events", server] as const

export class HomeSessionIndexInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HomeSessionIndexInvalid"
  }
}

export async function loadHomeSessionIndex(
  list: (
    input: { limit: number; order: "desc"; cursor?: string },
    options: { signal?: AbortSignal },
  ) => Promise<{ data?: unknown }>,
  eventSequence = 0,
  signal?: AbortSignal,
) {
  const data: unknown[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (;;) {
    const response = await list(
      {
        limit: HOME_V2_SESSION_PAGE_LIMIT,
        order: "desc",
        ...(cursor ? { cursor } : {}),
      },
      { signal },
    )
    if (!isRecord(response.data) || !Array.isArray(response.data.data))
      throw new HomeSessionIndexInvalid("Invalid V2 response")
    data.push(...response.data.data)
    if (response.data.data.length < HOME_V2_SESSION_PAGE_LIMIT)
      return { sessions: parseHomeSessionIndex({ data }), eventSequence }

    const next = isRecord(response.data.cursor) ? response.data.cursor.next : undefined
    if (typeof next !== "string" || cursors.has(next)) throw new HomeSessionIndexInvalid("Invalid V2 pagination cursor")
    cursors.add(next)
    cursor = next
  }
}

export function appendHomeSessionEvent(current: HomeSessionEvents | undefined, event: HomeSessionEvent) {
  const sequence = (current?.sequence ?? 0) + 1
  return {
    sequence,
    entries: [...(current?.entries ?? []), { sequence, event }],
  }
}

export function trimHomeSessionEvents(current: HomeSessionEvents | undefined, sequence: number): HomeSessionEvents {
  return {
    sequence: current?.sequence ?? sequence,
    entries: (current?.entries ?? []).filter((entry) => entry.sequence > sequence),
  }
}

export function homeSessionIndexSessions(index: HomeSessionIndex | undefined, events: HomeSessionEvents | undefined) {
  if (!index) return []
  return (events?.entries ?? [])
    .filter((entry) => entry.sequence > index.eventSequence)
    .reduce((sessions, entry) => applyHomeSessionEvent(sessions, entry.event), index.sessions)
}

export function homeSessionIndexRefresh(event: string, connected: boolean) {
  if (event === "server.connected") return { connected: true, refetch: connected }
  return {
    connected,
    refetch: event === "global.disposed" || event === "session.next.moved",
  }
}

// TODO(v2): Once released, load projects with client.v2.project.list() and use
// client.v2.session.list({ parentID: null, order: "desc" }). Then remove this
// full-table adapter, synthetic V1 fields, and client-side child filtering.
export function parseHomeSessionIndex(value: unknown): Session[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new HomeSessionIndexInvalid("Invalid V2 response")

  const seen = new Map<string, string>()
  return value.data.flatMap((item) => {
    if (!isV2Session(item)) throw new HomeSessionIndexInvalid("Invalid V2 session")
    const directory = item.location.directory
    const previous = seen.get(item.id)
    if (previous !== undefined && pathKey(previous) !== pathKey(directory))
      throw new HomeSessionIndexInvalid("Conflicting V2 session directories")
    seen.set(item.id, directory)
    if (item.parentID || item.time.archived !== undefined) return []
    return [toLegacySummary(item)]
  })
}

export function retainHomeSessions(sessions: Session[], limit: number, now: number) {
  const grouped = Map.groupBy(sessions, (session) => pathKey(session.directory))
  return [...grouped.values()].flatMap((items) => trimSessions(items, { limit, permission: {}, now }))
}

export function applyHomeSessionEvent(sessions: Session[], event: HomeSessionEvent) {
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
