import { expect, test } from "bun:test"
import { Effect } from "effect"
import { MyTodo } from "@opencode/core/my-todo"
import { KV } from "@opencode/core/kv"
import { Database } from "@opencode/core/database/database"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"

const project = (id: number, name: string, ids: number[]) => ({
  project_id: id,
  name,
  work_packages: ids.map((work_package_id) => ({ work_package_id })),
})

test("merges dates and projects by identity, retaining only the largest unique work package", () => {
  expect(
    MyTodo.projects({
      grouped_by_date: {
        "2026-09-07": { projects: [project(1, "Old name", [2, 10]), project(2, "Same name", [3])] },
        "2026-09-08": {
          projects: [
            project(1, "Current name", [5, 5]),
            project(2, "Same name", [7]),
            project(3, "Same name", [8]),
            project(4, "Duplicate", [8]),
            project(5, "Empty", []),
          ],
        },
      },
    }),
  ).toEqual([
    { project_id: 1, project_name: "Current name", work_package_id: 10 },
    { project_id: 2, project_name: "Same name", work_package_id: 7 },
    { project_id: 3, project_name: "Same name", work_package_id: 8 },
  ])
})

test("rejects invalid upstream responses and IDs", () => {
  expect(() => MyTodo.projects({})).toThrow()
  expect(() => MyTodo.projects({ grouped_by_date: { today: { projects: [project(1, "Invalid", [-1])] } } })).toThrow()
  expect(MyTodo.projects({ grouped_by_date: {} })).toEqual([])
})

test("restores the selected ID and name after reopening the database without consulting PLM", async () => {
  await using tmp = await tmpdir("my-todo-selection-")
  const layer = () =>
    LayerNode.compile(KV.node, {
      replacements: [Database.node.replace(Database.configured({ path: `${tmp.path}/selection.sqlite` }))],
    })
  const selected = { project_id: 1, project_name: "Saved project", work_package_id: 42 }
  await Effect.gen(function* () {
    expect(yield* MyTodo.selected()).toBeNull()
    yield* MyTodo.select(selected)
  }).pipe(Effect.provide(layer()), Effect.scoped, Effect.runPromise)
  await Effect.gen(function* () {
    expect(yield* MyTodo.selected()).toEqual(selected)
    MyTodo.projects({ grouped_by_date: { today: { projects: [project(1, "Renamed", [99])] } } })
    expect(yield* MyTodo.selected()).toEqual(selected)
    yield* MyTodo.select({ ...selected, work_package_id: 99 })
    expect((yield* MyTodo.selected())?.work_package_id).toBe(99)
  }).pipe(Effect.provide(layer()), Effect.scoped, Effect.runPromise)
})
