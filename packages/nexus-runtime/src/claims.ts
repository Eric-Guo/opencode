import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { APIError, type ExecutorClient } from "@cybros/agent"
import { atomic } from "./storage"

const Record = Schema.Struct({
  run: Schema.String,
  task: Schema.String,
  token: Schema.String,
  result: Schema.optional(
    Schema.Struct({
      outcome: Schema.Literals(["completed", "failed"]),
      content: Schema.optional(Schema.MutableJson),
      structured_content: Schema.optional(Schema.MutableJson),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
      is_error: Schema.optional(Schema.Boolean),
    }),
  ),
})
type Record = typeof Record.Type

// An interrupted write may already be on disk. Recover the receipt or report the uncertain outcome.
export class ClaimJournal {
  constructor(private readonly directory: string) {}

  private path(row: Pick<Record, "run" | "task">) {
    return join(
      this.directory,
      createHash("sha256")
        .update(JSON.stringify([row.run, row.task]))
        .digest("hex") + ".json",
    )
  }

  async save(row: Record) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await atomic(this.path(row), row)
  }

  remove(row: Record) {
    return rm(this.path(row), { force: true })
  }

  async recover(executor: ExecutorClient, signal: AbortSignal) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue
      const row = Schema.decodeUnknownSync(Schema.fromJsonString(Record))(
        await readFile(join(this.directory, name), "utf8"),
      )
      const task = executor.inboxTask(row.run, row.task)
      try {
        if ((await task.claimStatus(row.token, { signal })).active) {
          const result = row.result ?? {
            outcome: "failed" as const,
            content: "The runner stopped during execution. Inspect the project before retrying this task.",
          }
          await task.commit({ ...result, claim_token: row.token }, { signal })
        }
      } catch (error) {
        if (!(error instanceof APIError && [404, 409].includes(error.status))) throw error
      }
      await this.remove(row)
    }
  }
}
