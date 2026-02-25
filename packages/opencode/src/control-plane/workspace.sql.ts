import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/project/project.sql"
import type { Config } from "./schema"

export const WorkspaceTable = sqliteTable("workspace", {
  id: text().primaryKey(),
  branch: text().notNull(),
  project_id: text()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  config: text({ mode: "json" }).notNull().$type<Config>(),
})
