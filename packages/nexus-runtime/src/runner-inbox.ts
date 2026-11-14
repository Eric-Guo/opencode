import {
  APIError,
  type AnnouncedTool,
  type ClaimedTask,
  type ExecutorClient,
  type InboxTask,
  type JsonObject,
} from "@cybros/agent"
import { availableParallelism } from "node:os"
import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import type { HostTools } from "./host"
import type { Checkpoints } from "./checkpoints"
import type { RunnerTool } from "./extensions"
import type { ClaimJournal } from "./claims"
import { ClaimDeadline, ClaimInterrupted, ClaimLease, ClaimOperations } from "./claim-control"
import { claimResult, type ClaimResult } from "./claim-result"
import { operatorTools, RunnerAdmission, runClaim, tools } from "./runner"

type Hint = { run_public_id: string; task_key: string; tool_name?: string | null; role?: string | null }
const Notification = Schema.Struct({
  event: Schema.Struct({
    type: Schema.String,
    kind: Schema.optional(Schema.String),
    run_public_id: Schema.optional(Schema.String),
    task_key: Schema.optional(Schema.String),
    tool_name: Schema.optional(Schema.NullOr(Schema.String)),
    role: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})
type OwnedTask = { cancel: AbortController; started: boolean; work?: Promise<void> }

/** Both entrances claim the authoritative row; realtime carries no executable arguments. */
export class RunnerInbox {
  private readonly running = new Map<string, OwnedTask>()
  private readonly programs = new Set<Promise<void>>()
  private readonly validators = new WeakMap<AnnouncedTool, Schema.Codec<unknown>>()
  private readonly unsubscribe: () => void
  private readonly capacity: number
  private starting = 0
  private after?: string
  private failure?: unknown
  private stopped = false
  private deferred = false
  private readonly counts = { claimed: 0, swept: 0, nudged: 0, canceled: 0 }
  private issue: { type: string; code: string | null } | null = null

  constructor(
    private readonly options: {
      executor: ExecutorClient
      id: string
      root: string
      journal: ClaimJournal
      signal: AbortSignal
      extensions: () => readonly RunnerTool[]
      admission: RunnerAdmission
      wake(): void
      host?: HostTools
      checkpoints?: Checkpoints
      startupLimit?: number
    },
  ) {
    this.capacity = options.startupLimit ?? Math.max(2, Math.min(8, availableParallelism()))
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1)
      throw new Error("Runner startup capacity must be a positive integer.")
    this.unsubscribe = options.admission.subscribe(() => this.capacityAvailable())
  }

  snapshot() {
    return {
      ...this.counts,
      running: !this.stopped && !this.options.signal.aborted && !this.failure,
      in_flight: this.running.size,
      starting: this.starting,
      startup_limit: this.capacity,
      issue: this.issue,
    }
  }

  notify(message: unknown) {
    const decoded = Schema.decodeUnknownOption(Notification)(message)
    if (decoded._tag === "None") return
    const event = decoded.value.event
    if (!event.run_public_id || !event.task_key) return
    if (event.type === "work_canceled") {
      const owned = this.running.get(JSON.stringify([event.run_public_id, event.task_key]))
      if (owned && !owned.cancel.signal.aborted) {
        this.counts.canceled++
        owned.cancel.abort(new ClaimInterrupted("The tool was interrupted by Nexus cancellation."))
      }
      return
    }
    if (event.type !== "work_available" || event.kind !== "tool_call") return
    this.counts.nudged++
    this.track(this.take({ ...event, run_public_id: event.run_public_id, task_key: event.task_key }))
  }

  async sweep() {
    if (this.failure) throw this.failure
    if (this.stopped || this.options.signal.aborted) return
    this.counts.swept++
    try {
      const errors = await this.options.journal.recover(this.options.executor, this.options.signal, this.running)
      errors.forEach((error) => this.failed(error))
      const page = await this.options.executor.inbox.list(
        { after: this.after, limit: 50 },
        { signal: this.options.signal },
      )
      this.after = page.next_after ?? undefined
      await Promise.all(
        page.items
          .filter((row) => !row.claimed && this.addressed(row))
          .map((row) => this.take({ ...row, role: row.addressed_to!.role })),
      )
      if (this.after) this.options.wake()
    } catch (error) {
      this.failed(error)
    }
    if (this.failure) throw this.failure
  }

  async close() {
    this.stopped = true
    this.unsubscribe()
    this.running.forEach((owned) => owned.cancel.abort(new ClaimInterrupted("The runner stopped.")))
    await this.drain()
  }

  async drain() {
    while (this.programs.size) await Promise.allSettled([...this.programs])
  }

  private capacityAvailable() {
    if (!this.deferred || this.stopped) return
    this.deferred = false
    this.options.wake()
  }

  private addressed(row: InboxTask) {
    return (
      row.kind === "tool_call" &&
      ["agent", "runner"].includes(row.addressed_to?.role ?? "") &&
      row.addressed_to?.executor_public_id === this.options.id
    )
  }

  private track(work: Promise<unknown>) {
    const tracked = work.then(
      () => {},
      (error: unknown) => this.failed(error),
    )
    this.programs.add(tracked)
    void tracked.then(() => this.programs.delete(tracked))
  }

  private failed(error: unknown) {
    this.issue = {
      type: error instanceof Error ? error.name : "RunnerError",
      code: error instanceof APIError ? error.code : null,
    }
    if (error instanceof APIError && error.status === 401) {
      this.failure = error
      this.options.wake()
    }
  }

  private async take(hint: Hint) {
    const key = JSON.stringify([hint.run_public_id, hint.task_key])
    if (this.stopped || this.options.signal.aborted || this.failure || this.running.has(key)) return
    if (!["agent", "runner"].includes(hint.role ?? "")) {
      this.options.wake()
      return
    }
    const extensions = this.options.extensions()
    if (!hint.tool_name && extensions.some((tool) => tool.resource)) {
      this.options.wake()
      return
    }
    if (this.starting >= this.capacity) {
      this.deferred = true
      return
    }
    const reserved = extensions.find(
      (tool) => tool.definition.name === hint.tool_name && (tool.role ?? "runner") === hint.role,
    )
    const release = this.options.admission.reserve(reserved)
    if (!release) {
      this.deferred = true
      return
    }
    const owned: OwnedTask = { cancel: new AbortController(), started: false }
    this.running.set(key, owned)
    this.starting++
    const started = () => {
      if (owned.started) return
      owned.started = true
      this.starting--
      this.capacityAvailable()
    }
    try {
      const claim = await this.options.executor
        .inboxTask(hint.run_public_id, hint.task_key)
        .claim({ signal: this.options.signal })
        .catch((error: unknown) => {
          if (
            error instanceof APIError &&
            ([404, 409].includes(error.status) ||
              ["already_claimed", "task_not_claimable", "not_addressed_here", "not_eligible", "not_found"].includes(
                error.code ?? "",
              ))
          )
            return null
          throw error
        })
      if (!claim) {
        started()
        release()
        this.running.delete(key)
        return
      }
      this.counts.claimed++
      this.track(
        this.finish(hint, claim, reserved, extensions, owned, started).finally(() => {
          started()
          // A canceled, non-cooperative handler still owns its local resource until its actual exit.
          void Promise.resolve(owned.work).then(() => {
            release()
            this.running.delete(key)
          })
        }),
      )
    } catch (error) {
      started()
      release()
      this.running.delete(key)
      this.failed(error)
    }
  }

  private async finish(
    hint: Hint,
    claim: ClaimedTask,
    reserved: RunnerTool | undefined,
    extensions: readonly RunnerTool[],
    owned: OwnedTask,
    started: () => void,
  ) {
    const task = this.options.executor.inboxTask(hint.run_public_id, hint.task_key)
    const extension = extensions.find(
      (tool) =>
        tool.definition.name === claim.task.tool_name && (tool.role ?? "runner") === claim.task.addressed_to?.role,
    )
    const definition =
      extension?.definition ??
      (claim.task.addressed_to?.role === "runner"
        ? [...tools, ...operatorTools].find((tool) => tool.name === claim.task.tool_name)
        : undefined)
    const lease = new ClaimLease(task, claim, this.options.signal, !extension?.internalTimeout, definition?.timeout_ms)
    const executing = AbortSignal.any([lease.executionSignal, owned.cancel.signal])
    const record = { run: hint.run_public_id, task: hint.task_key, token: claim.claim_token }
    lease.start()
    try {
      await this.options.journal.save(record)
      const result =
        this.refusal(hint, claim.task, reserved, extension, definition) ??
        (await this.execute(
          claim,
          executing,
          owned,
          extensions.filter((tool) => (tool.role ?? "runner") === claim.task.addressed_to?.role),
          started,
        ))
      await lease.finishExecution()
      const bounded = claimResult(result)
      await this.options.journal.save({ ...record, result: bounded })
      if (this.options.signal.aborted) return
      await this.options.journal.settle(
        this.options.executor,
        { ...record, result: bounded },
        this.options.signal,
        () => lease.deadlineAt,
      )
    } finally {
      started()
      await lease.close()
    }
  }

  private refusal(
    hint: Hint,
    row: InboxTask,
    reserved: RunnerTool | undefined,
    extension: RunnerTool | undefined,
    definition: AnnouncedTool | undefined,
  ): ClaimResult | undefined {
    const binding = row.executor_context?.["opencode.directory"]
    const placed =
      binding === this.options.root ||
      (extension?.role === "agent" && binding === undefined) ||
      (["files_bytes", "checkpoints", "checkpoint_restore"].includes(row.tool_name ?? "") &&
        binding === undefined &&
        !row.conversation_public_id)
    if (
      !this.addressed(row) ||
      row.run_public_id !== hint.run_public_id ||
      row.task_key !== hint.task_key ||
      row.addressed_to?.role !== hint.role ||
      !placed
    )
      return { outcome: "failed", content: "This claim does not match its captured runner placement." }
    if (
      extension?.resource?.name !== reserved?.resource?.name ||
      extension?.resource?.concurrency !== reserved?.resource?.concurrency
    )
      return { outcome: "failed", content: "Tool admission changed before execution; retry this call." }
    if (!definition)
      return { outcome: "failed", content: "This runner no longer serves the claimed tool on this role." }
    if (this.valid(definition, row.tool_input)) return
    return {
      outcome: "completed",
      is_error: true,
      content: "invalid_tool_arguments: the arguments do not match this tool's declared schema.",
    }
  }

  private valid(definition: AnnouncedTool, input: JsonObject) {
    const schema =
      this.validators.get(definition) ??
      Schema.make<Schema.Codec<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(
          JsonSchema.fromSchemaDraft2020_12(definition.input_schema ?? { type: "object" }),
        ).ast,
      )
    this.validators.set(definition, schema)
    return Schema.decodeUnknownOption(schema)(input)._tag === "Some"
  }

  private async execute(
    claim: ClaimedTask,
    signal: AbortSignal,
    owned: OwnedTask,
    extensions: readonly RunnerTool[],
    started: () => void,
  ): Promise<ClaimResult> {
    if (signal.aborted) return interrupted(signal.reason)
    const task = this.options.executor.inboxTask(claim.task.run_public_id, claim.task.task_key)
    const operations = new ClaimOperations(task, claim.claim_token, signal)
    const operation = (key: string, request: JsonObject) => operations.invoke(key, request)
    const ask = async (key: string, prompt: string, options?: string[]) => {
      const result = await operation(key, { kind: "ask", input: { prompt, ...(options?.length ? { options } : {}) } })
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        result.status !== "completed" ||
        result.is_error ||
        !Array.isArray(result.content)
      )
        throw new Error("Question was not answered.")
      return result.content
        .flatMap((block) =>
          block &&
          typeof block === "object" &&
          !Array.isArray(block) &&
          block.type === "text" &&
          typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n")
    }
    const running = runClaim(
      this.options.executor,
      claim.task,
      this.options.root,
      signal,
      this.options.host,
      this.options.checkpoints,
      extensions,
      ask,
      claim.claim_token,
      operation,
    ).then(
      (result): ClaimResult => ({ ...result, outcome: "completed" }),
      (error: unknown): ClaimResult =>
        signal.aborted
          ? interrupted(signal.reason)
          : { outcome: "failed", content: error instanceof Error ? error.message : "The tool could not run." },
    )
    owned.work = running.then(() => {})
    // The synchronous prefix has reached its first wait; child tasks can now reserve startup capacity.
    started()
    return new Promise<ClaimResult>((resolve) => {
      const abort = () => resolve(interrupted(signal.reason))
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      void running.then(resolve).finally(() => signal.removeEventListener("abort", abort))
    })
  }
}

function interrupted(reason: unknown): ClaimResult {
  return reason instanceof ClaimDeadline
    ? {
        outcome: "completed",
        is_error: true,
        content:
          "The tool timed out. Cancellation was requested; its external effects may be incomplete. Check them before retrying.",
      }
    : { outcome: "failed", content: reason instanceof Error ? reason.message : "The tool was interrupted." }
}
