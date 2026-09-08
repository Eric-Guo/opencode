import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("persists the chosen work project through the authenticated HTTP API", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-my-todo-")))
    const server = yield* startServer(tmp.path)
    const current = yield* Effect.promise(() =>
      fetch(new URL(`/api/project/current?directory=${encodeURIComponent(tmp.path)}`, server.base), {
        headers: server.headers,
      }).then((response) => response.json()),
    )
    const url = new URL(`/api/project/${current.id}`, server.base)
    const initial = yield* Effect.promise(() =>
      fetch(new URL("/api/project", server.base), { headers: server.headers }),
    )
    expect(initial.status).toBe(200)
    expect(
      (yield* Effect.promise(() => initial.json())).find((project: { id: string }) => project.id === current.id).myTodo,
    ).toBeUndefined()
    const selected = { project_id: 12485, project_name: "SigmaAgents智能体项目", work_package_id: 450344 }
    const saved = yield* Effect.promise(() =>
      fetch(url, {
        method: "PATCH",
        headers: { ...server.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ myTodo: selected }),
      }),
    )
    expect(saved.status).toBe(200)
    expect((yield* Effect.promise(() => saved.json())).myTodo).toEqual(selected)
    const restored = yield* Effect.promise(() =>
      fetch(new URL("/api/project", server.base), { headers: server.headers }),
    )
    expect(
      (yield* Effect.promise(() => restored.json())).find((project: { id: string }) => project.id === current.id)
        .myTodo,
    ).toEqual(selected)
    const invalid = yield* Effect.promise(() =>
      fetch(url, {
        method: "PATCH",
        headers: { ...server.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ myTodo: { ...selected, work_package_id: -1 } }),
      }),
    )
    expect(invalid.status).toBe(400)
    const unauthorized = yield* Effect.promise(() =>
      fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ myTodo: selected }),
      }),
    )
    expect(unauthorized.status).toBe(401)
  }),
)
