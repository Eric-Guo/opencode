export * as MyTodo from "./my-todo.js"
import { Schema } from "effect"

export const Project = Schema.Struct({
  project_id: Schema.Int.check(Schema.isGreaterThan(0)),
  project_name: Schema.String,
  work_package_id: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({ identifier: "MyTodo.Project" })
export interface Project extends Schema.Schema.Type<typeof Project> {}
