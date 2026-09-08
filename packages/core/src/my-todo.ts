export * as MyTodo from "./my-todo"

import { MyTodo } from "@opencode/schema/my-todo"
import { Effect, Schema } from "effect"
import { KV } from "./kv"

const key = "thape:my-todo:selected"
const Response = Schema.Struct({
  grouped_by_date: Schema.Record(
    Schema.String,
    Schema.Struct({
      projects: Schema.Array(
        Schema.Struct({
          project_id: MyTodo.Project.fields.project_id,
          name: Schema.String,
          work_packages: Schema.Array(Schema.Struct({ work_package_id: MyTodo.Project.fields.work_package_id })),
        }),
      ),
    }),
  ),
})

export function projects(value: unknown) {
  const data = Schema.decodeUnknownSync(Response)(value)
  const grouped = new Map<number, MyTodo.Project>()
  Object.entries(data.grouped_by_date)
    .sort(([a], [b]) => b.localeCompare(a))
    .forEach(([, day]) => {
      day.projects.forEach((project) => {
        project.work_packages.forEach((work) => {
          const previous = grouped.get(project.project_id)
          if (previous && previous.work_package_id >= work.work_package_id) return
          grouped.set(project.project_id, {
            project_id: project.project_id,
            project_name: previous?.project_name ?? project.name,
            work_package_id: work.work_package_id,
          })
        })
      })
    })
  const seen = new Set<number>()
  return [...grouped.values()].filter((project) => {
    if (seen.has(project.work_package_id)) return false
    seen.add(project.work_package_id)
    return true
  })
}

export const list = Effect.fn("MyTodo.list")(function* () {
  const token = process.env.THAPE_SSO_BEARER_API_KEY
  if (!token) return []
  return yield* Effect.tryPromise(async () => {
    const response = await fetch("https://plm.thape.com.cn/my_todo.json", {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`PLM returned HTTP ${response.status}`)
    return projects(await response.json())
  })
})

export const selected = Effect.fn("MyTodo.selected")(function* () {
  const kv = yield* KV.Service
  const value = yield* kv.get(key)
  if (value === undefined) return null
  return yield* Schema.decodeUnknownEffect(MyTodo.Project)(value).pipe(Effect.orDie)
})

export const select = Effect.fn("MyTodo.select")(function* (project: MyTodo.Project) {
  const kv = yield* KV.Service
  yield* kv.set(key, project)
  return project
})
