import { describe, expect, test } from "bun:test"
import {
  applyHomeSessionEvent,
  HOME_V2_SESSION_LIMIT,
  HomeSessionSnapshotUnsupported,
  loadHomeSessionSnapshot,
  parseHomeSessionSnapshot,
  retainHomeSessions,
} from "./home-session-snapshot"

const session = (input: {
  id: string
  directory?: string
  parentID?: string
  archived?: number
  updated?: number
}) => ({
  id: input.id,
  parentID: input.parentID,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: input.updated ?? 1, archived: input.archived },
  title: input.id,
  location: { directory: input.directory ?? "/project" },
})

describe("Home V2 session snapshot", () => {
  test("loads the Home snapshot with one global V2 request", async () => {
    const calls: unknown[] = []
    const result = await loadHomeSessionSnapshot(async (input) => {
      calls.push(input)
      return { data: { data: [session({ id: "root" })], cursor: {} } }
    })

    expect(result).toHaveLength(1)
    expect(calls).toEqual([{ limit: HOME_V2_SESSION_LIMIT, order: "desc" }])
  })

  test("maps visible roots without creating incomplete legacy cache entries", () => {
    const result = parseHomeSessionSnapshot({
      data: [
        session({ id: "root", updated: 30 }),
        session({ id: "child", parentID: "root", updated: 40 }),
        session({ id: "archived", archived: 50, updated: 50 }),
      ],
      cursor: {},
    })

    expect(result).toEqual([
      expect.objectContaining({
        id: "root",
        slug: "root",
        version: "",
        directory: "/project",
        projectID: "project",
        title: "root",
        time: { created: 1, updated: 30 },
      }),
    ])
  })

  test("rejects malformed and potentially truncated snapshots", () => {
    expect(() => parseHomeSessionSnapshot({ data: "bad", cursor: {} })).toThrow(HomeSessionSnapshotUnsupported)
    expect(() =>
      parseHomeSessionSnapshot({
        data: Array.from({ length: HOME_V2_SESSION_LIMIT }, (_, index) => session({ id: `session-${index}` })),
        cursor: { next: "more" },
      }),
    ).toThrow(HomeSessionSnapshotUnsupported)
  })

  test("preserves the per-directory Home retention limit", () => {
    const now = 10 * 60 * 60 * 1000
    const sessions = Array.from({ length: 80 }, (_, index) => ({
      ...parseHomeSessionSnapshot({ data: [session({ id: `session-${index}`, updated: index + 1 })], cursor: {} })[0],
      directory: index % 2 === 0 ? "/one" : "/two",
    }))

    const retained = retainHomeSessions(sessions, 10, now)
    expect(retained.filter((item) => item.directory === "/one")).toHaveLength(10)
    expect(retained.filter((item) => item.directory === "/two")).toHaveLength(10)
  })

  test("replays session events over an in-flight snapshot", () => {
    const initial = parseHomeSessionSnapshot({ data: [session({ id: "old" })], cursor: {} })
    const created = { ...initial[0], id: "new", slug: "new", title: "new", time: { created: 2, updated: 2 } }

    expect(
      [
        { type: "session.created", properties: { info: created } },
        { type: "session.deleted", properties: { info: initial[0] } },
      ].reduce(applyHomeSessionEvent, initial),
    ).toEqual([created])
  })
})
