import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("persists the chosen work project through the authenticated HTTP API", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-my-todo-")))
    const server = yield* startServer(tmp.path)
    const url = new URL("/api/server/my-todo/selection", server.base)
    const initial = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    expect(initial.status).toBe(200)
    expect(yield* Effect.promise(() => initial.json())).toBeNull()
    const selected = { project_id: 12485, project_name: "SigmaAgents智能体项目", work_package_id: 450344 }
    const saved = yield* Effect.promise(() =>
      fetch(url, {
        method: "PUT",
        headers: { ...server.headers, "Content-Type": "application/json" },
        body: JSON.stringify(selected),
      }),
    )
    expect(saved.status).toBe(200)
    expect(yield* Effect.promise(() => saved.json())).toEqual(selected)
    const restored = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    expect(yield* Effect.promise(() => restored.json())).toEqual(selected)
    const invalid = yield* Effect.promise(() =>
      fetch(url, {
        method: "PUT",
        headers: { ...server.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...selected, work_package_id: -1 }),
      }),
    )
    expect(invalid.status).toBe(400)
    const unauthorized = yield* Effect.promise(() =>
      fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selected) }),
    )
    expect(unauthorized.status).toBe(401)
  }),
)
