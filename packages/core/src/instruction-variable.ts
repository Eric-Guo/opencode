export * as InstructionVariable from "./instruction-variable.js"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "./database/database.js"
import type { ProjectSchema } from "./project/schema.js"
import { ProjectTable } from "./project/sql.js"

type Variables = {
  readonly env?: Record<string, string>
  // Undefined means no project context; null means the current project has no selection.
  readonly project?: Pick<typeof ProjectTable.$inferSelect, "project_id" | "project_name" | "work_package_id"> | null
}

export function substitute(content: string, variables: Variables = {}) {
  return content.replace(/\{(env|project):([^}]+)\}/g, (token, type: string, name: string) => {
    if (type === "env") return variables.env?.[name] ?? process.env[name] ?? ""
    if (variables.project === undefined) return token
    if (name !== "project_id" && name !== "project_name" && name !== "work_package_id") return token

    return String(variables.project?.[name] ?? "")
  })
}

export const load = Effect.fn("InstructionVariable.load")(function* (
  db: Database.Interface["db"],
  projectID: ProjectSchema.ID,
) {
  const project = yield* db
    .select({
      project_id: ProjectTable.project_id,
      project_name: ProjectTable.project_name,
      work_package_id: ProjectTable.work_package_id,
    })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, projectID))
    .get()
    .pipe(Effect.orDie)

  return (content: string) => substitute(content, { project: project ?? null })
})
