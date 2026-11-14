import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { APIError, TransportError, type ExecutorClient } from "@cybros/agent"
import { setTimeout as delay } from "node:timers/promises"
import { atomic } from "./storage"
import { claimResult } from "./claim-result"

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
      title: Schema.optional(Schema.String),
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

  async settle(executor: ExecutorClient, row: Record, signal: AbortSignal, deadlineAt: () => number) {
    if (!row.result) throw new Error("A claim must have a durable result before settlement.")
    const task = executor.inboxTask(row.run, row.task)
    const fallback = Date.now() + 60000
    let retry = 1000

    while (!signal.aborted) {
      try {
        await task.commit({ ...row.result, claim_token: row.token }, { signal })
        await this.remove(row)
        return
      } catch (error) {
        if (error instanceof APIError && [404, 409].includes(error.status)) {
          await this.remove(row)
          return
        }
        if (
          !(
            error instanceof TransportError ||
            (error instanceof APIError && (error.status === 429 || error.status >= 500))
          )
        )
          throw error

        // A lost commit response may already have settled the claim. Never rerun the handler.
        const status = await task.claimStatus(row.token, { signal }).catch((cause: unknown) => {
          if (cause instanceof APIError && [404, 409].includes(cause.status)) return { active: false }
          if (cause instanceof APIError && cause.status === 401) throw cause
          return null
        })
        if (status && !status.active) {
          await this.remove(row)
          return
        }
        const supplied =
          error instanceof APIError && error.retryAfter
            ? Number.isFinite(Number(error.retryAfter))
              ? Number(error.retryAfter) * 1000
              : Date.parse(error.retryAfter) - Date.now()
            : 0
        const wait = Math.max(retry, supplied || 0)
        if (Date.now() + wait >= (Number.isFinite(deadlineAt()) ? deadlineAt() : fallback)) throw error

        await delay(wait, undefined, { signal })
        retry = Math.min(retry * 2, 8000)
      }
    }
    signal.throwIfAborted()
  }

  async recover(executor: ExecutorClient, signal: AbortSignal, active: Pick<ReadonlySet<string>, "has"> = new Set()) {
    const errors: unknown[] = []
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue
      try {
        const row = Schema.decodeUnknownSync(Schema.fromJsonString(Record))(
          await readFile(join(this.directory, name), "utf8"),
        )
        if (active.has(JSON.stringify([row.run, row.task]))) continue
        const task = executor.inboxTask(row.run, row.task)
        if ((await task.claimStatus(row.token, { signal })).active) {
          const result = row.result ?? {
            outcome: "failed" as const,
            content: "The runner stopped during execution. Inspect the project before retrying this task.",
          }
          const recovered = { ...row, result: claimResult(result) }
          await this.save(recovered)
          await this.settle(executor, recovered, signal, () => Date.now())
        }
        await this.remove(row)
      } catch (error) {
        if (signal.aborted || (error instanceof APIError && error.status === 401)) throw error
        if (error instanceof APIError && [404, 409].includes(error.status)) {
          await rm(join(this.directory, name), { force: true })
          continue
        }
        errors.push(error)
      }
    }
    return errors
  }
}
