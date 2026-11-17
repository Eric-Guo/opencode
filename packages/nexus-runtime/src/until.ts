import { createHash } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import {
  APIError,
  TransportError,
  Steps,
  type Client,
  type JsonObject,
  type ModelDefaults,
  type Run,
  type RunCandidate,
  type Step,
  type Task,
  type TaskDetail,
} from "@cybros/agent"
import { Schema } from "effect"
import { StoreDocument } from "./document"

type RunScope = ReturnType<ReturnType<Client["workspace"]>["run"]>

const Policy = Schema.Struct({
  command: Schema.NonEmptyString,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  directory: Schema.NullOr(Schema.String),
  runner: Schema.NonEmptyString,
  seed: Schema.Record(Schema.String, Schema.MutableJson),
})
const Note = Schema.Struct({
  owner: Schema.NonEmptyString,
  conversation: Schema.NonEmptyString,
  policy: Policy,
  run: Schema.NullOr(Schema.String),
})
export type UntilPolicy = {
  command: string
  attempts: number
  directory: string | null
  runner: string
  seed: ModelDefaults & { executor_contexts: Record<string, JsonObject> }
}
export type UntilCheck = {
  attempt: number
  attempts: number
  exit_status: number | null
  timed_out: boolean
  passed: boolean
  at: string
}
type Verdict = { exit_status: number | null; timed_out: boolean; passed: boolean; reason?: string }
const terminal = new Set(["completed", "failed", "canceled", "timed_out", "uncertain", "skipped"])
const work = new Set(["model_task", "tool_task", "delegation_task"])
const started = (task: Task) => !terminal.has(task.status) && task.status !== "waiting"
const attemptOf = (key: string) => Number(/^(?:check|hold)-(\d+)$/.exec(key)?.[1] ?? 0)

export function untilPolicy(input: unknown): UntilPolicy {
  const value = Schema.decodeUnknownSync(Policy)(input)
  const contexts = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.MutableJson)),
  )(value.seed.executor_contexts)
  const context = contexts[value.runner]
  const environment = context?.["opencode.environment"] ?? context?.["rho.environment"]
  const root =
    environment === undefined
      ? context?.["opencode.directory"]
      : Schema.decodeUnknownSync(Schema.Struct({ root: Schema.NonEmptyString }))(environment).root
  if (!value.command.trim() || typeof root !== "string" || !root)
    throw new Error("Invalid durable acceptance-check policy.")
  return { ...value, seed: { ...value.seed, executor_contexts: contexts } }
}

export function untilParagraph(policy: Pick<UntilPolicy, "command" | "attempts" | "directory">) {
  return `The acceptance check is \`${policy.command}\`, run in ${policy.directory ?? "the runner's root"}. Run it yourself before you finish. When you believe the task is done, end your turn with a short message saying what you did; the check will then be run for you. If it fails you will see its output and be asked to continue; you have ${policy.attempts} checks in total. Make it pass by completing the task — do not edit, skip or weaken what the command checks.`
}

export function untilKey(run: string, attempt: number, step = "check") {
  const hash = createHash("sha256").update(`until:${run}:${attempt}:${step}`).digest("hex")
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

export function untilSteps(policy: UntilPolicy, attempt = 1, timeoutSeconds = 120): Step[] {
  return [
    Steps.tool({
      name: "bash",
      key: "check-" + attempt,
      route: { kind: "runner", runner_executor_public_id: policy.runner },
      executor_context: policy.seed.executor_contexts[policy.runner],
      input: {
        command: policy.command,
        ...(policy.directory === null ? {} : { workdir: policy.directory }),
        timeout: timeoutSeconds,
      },
      timeout_ms: 600000,
      on_failure: "absorb",
    }),
    Steps.ask({
      key: "hold-" + attempt,
      prompt: "Waiting for OpenCode to advance acceptance check " + attempt,
      indefinite: true,
    }),
  ]
}

export function untilVerdict(detail: TaskDetail): Verdict {
  if (detail.task.status !== "completed")
    return {
      exit_status: null,
      timed_out: false,
      passed: false,
      reason: String(detail.task.error?.detail ?? detail.task.error?.key ?? detail.task.status),
    }
  const content = detail.structured_content
  const exit = content && typeof content === "object" && !Array.isArray(content) ? content.exit_status : undefined
  if (typeof exit === "number" && Number.isInteger(exit))
    return { exit_status: exit, timed_out: false, passed: exit === 0 }
  if (detail.output?.includes("Command timed out")) return { exit_status: null, timed_out: true, passed: false }
  return {
    exit_status: null,
    timed_out: false,
    passed: false,
    reason: detail.output?.split("\n")[0].trim() || "the check answered nothing",
  }
}

/** Advances only settled graph facts; the atomic append both resolves the hold and plants its successor. */
export class UntilGate {
  private checking = false
  private finished = false
  private readonly observations: UntilCheck[] = []
  constructor(
    readonly policy: UntilPolicy,
    readonly run: string,
    private readonly timeoutSeconds = 120,
  ) {}

  get done() {
    return this.finished
  }
  get checks() {
    return structuredClone(this.observations)
  }
  cancel() {
    this.finished = true
  }

  ready(run: Run) {
    if (this.finished || run.public_id !== this.run || run.status !== "running" || run.attention !== null) return
    const hold = run.tasks
      .filter((task) => task.kind === "await_task" && attemptOf(task.key) > 0 && task.key.startsWith("hold-"))
      .sort((a, b) => attemptOf(b.key) - attemptOf(a.key))[0]
    if (!hold || !started(hold)) return
    const attempt = attemptOf(hold.key)
    if (!run.tasks.some((task) => task.key === "check-" + attempt && terminal.has(task.status))) return
    if (run.tasks.some((task) => work.has(task.kind) && !terminal.has(task.status))) return
    if (run.tasks.some((task) => ["summary", "report", "work-" + (attempt + 1)].includes(task.key))) return
    return attempt
  }

  async reconsider(context: RunScope, signal?: AbortSignal) {
    if (this.checking || this.finished) return
    this.checking = true
    try {
      const run = await context.fetch({ signal })
      if (["completed", "failed", "canceled"].includes(run.status)) {
        this.finished = true
        return
      }
      const attempt = this.ready(run)
      if (attempt === undefined) return
      const verdict = untilVerdict(await context.task("check-" + attempt).fetch({ signal }))
      if (!verdict.reason && !this.observations.some((check) => check.attempt === attempt))
        this.observations.push({
          attempt,
          attempts: this.policy.attempts,
          exit_status: verdict.exit_status,
          timed_out: verdict.timed_out,
          passed: verdict.passed,
          at: new Date().toISOString(),
        })
      const closing = verdict.passed || !!verdict.reason || attempt >= this.policy.attempts
      const how = verdict.passed ? "passed" : verdict.timed_out ? "timed out" : "exit " + verdict.exit_status
      const header = `The acceptance check \`${this.policy.command}\` ${verdict.timed_out ? "did not finish in time" : "exited with status " + verdict.exit_status} (check ${attempt} of ${this.policy.attempts}). Its output is the result of \`check-${attempt}\` above.`
      const prompt = verdict.reason
        ? `The acceptance check \`${this.policy.command}\` cannot continue: ${verdict.reason}. Do not continue working. Reply with a short report of what you did and what remains.`
        : verdict.passed
          ? `The acceptance check \`${this.policy.command}\` passed. Reply with a short summary of what you did; that is this run's answer.`
          : closing
            ? header +
              " That was the last allowed run.\n\nDo not continue working. Reply with a short report: what you did, what still fails, and what you would try next."
            : header +
              "\n\nContinue the task so the check passes — do not edit, skip or weaken what it checks. When you believe it is done, end your turn with a short message."
      const step = Steps.model({
        ...this.policy.seed,
        key: verdict.passed ? "summary" : closing ? "report" : "work-" + (attempt + 1),
        prompt,
        results: ["check-" + attempt, "hold-" + attempt],
      })
      const input = {
        steps: [step, ...(closing ? [] : untilSteps(this.policy, attempt + 1, this.timeoutSeconds))],
        resolve: [
          { task: "hold-" + attempt, content: `check ${attempt}/${this.policy.attempts}: ${verdict.reason ?? how}` },
        ],
      }
      for (let retry = 0; retry <= 3; retry++) {
        try {
          await context.append(input, {
            idempotencyKey: untilKey(this.run, attempt, verdict.reason ? "release" : "check"),
            signal,
          })
          this.finished = closing
          return
        } catch (error) {
          if (error instanceof APIError && error.status === 409) return
          if (!(error instanceof APIError || error instanceof TransportError)) throw error
          if (retry === 3) return
          await setTimeout(2000 * (retry + 1), undefined, { signal })
        }
      }
    } finally {
      this.checking = false
    }
  }
}

/** Durable recovery is independent of connected editors and other presentation followers. */
export class Until {
  private readonly gates = new Map<string, { workspace: string; gate: UntilGate }>()
  constructor(
    private readonly client: Client,
    private readonly owner: string,
    private readonly timeoutSeconds: number | (() => number) = 120,
  ) {}

  async prepare(workspace: string, conversation: string, policy: UntilPolicy) {
    const prepared = this.plan(policy)
    await this.save(workspace, conversation, policy)
    return { instructions: prepared.instructions, steps: prepared.steps }
  }

  plan(policy: UntilPolicy) {
    const value = untilPolicy(policy)
    return {
      instructions: untilParagraph(value),
      steps: untilSteps(
        value,
        1,
        typeof this.timeoutSeconds === "function" ? this.timeoutSeconds() : this.timeoutSeconds,
      ),
      admission_notes: { "nexus.until": Schema.decodeUnknownSync(Policy)(value) },
    }
  }

  async save(workspace: string, conversation: string, policy: unknown) {
    const value = untilPolicy(policy)
    const recorded = await this.document(workspace, conversation).change(
      (current) =>
        current ?? {
          owner: this.owner,
          conversation,
          policy: Schema.decodeUnknownSync(Policy)(value),
          run: null,
        },
    )
    if (recorded.owner !== this.owner || !isDeepStrictEqual(recorded.policy, value))
      throw new Error("This conversation already has another acceptance-check policy.")
  }

  async recover(candidate: RunCandidate, signal?: AbortSignal) {
    const document = this.document(candidate.workspace_public_id, candidate.conversation_public_id)
    const note = await document.read().catch((error: unknown) => {
      if (Schema.isSchemaError(error)) return null
      throw error
    })
    if (
      !note ||
      note.owner !== this.owner ||
      note.conversation !== candidate.conversation_public_id ||
      (note.run !== null && note.run !== candidate.public_id)
    )
      return
    const workspace = this.client.workspace(candidate.workspace_public_id)
    const context = workspace.run(candidate.public_id)
    const policy = untilPolicy(note.policy)
    if (note.run === null) {
      const run = await context.fetch({ signal })
      if (
        run.public_id !== candidate.public_id ||
        run.turn?.conversation_public_id !== candidate.conversation_public_id ||
        run.turn.public_id !== candidate.turn_public_id
      )
        return
      const conversation = workspace.conversation(candidate.conversation_public_id)
      const turn = await conversation.turns.fetch(candidate.turn_public_id, { include_hidden: true }, { signal })
      if (!turn.input_public_id || turn.position !== 0) return
      const original = await conversation.inputs.materialization(
        turn.input_public_id,
        { include_hidden: true },
        { signal },
      )
      if (original?.run_public_id !== candidate.public_id || original.turn_public_id !== candidate.turn_public_id)
        return
      if (
        !run.tasks.some((task) => task.key === "hold-1" && task.kind === "await_task") ||
        !run.tasks.some((task) => task.key === "check-1" && task.kind === "tool_task")
      )
        return
      const check = await context.task("check-1").fetch({ signal })
      if (
        check.task.tool_name !== "bash" ||
        check.tool_input?.command !== policy.command ||
        (check.tool_input?.workdir ?? null) !== policy.directory ||
        check.task.target?.executor_public_id !== policy.runner ||
        !isDeepStrictEqual(check.executor_context, policy.seed.executor_contexts[policy.runner])
      )
        return
      const bound = await document
        .change((current) => {
          if (!current || !isDeepStrictEqual(current, note))
            throw new Error("Acceptance-check policy changed during recovery.")
          return { ...current, run: candidate.public_id }
        })
        .catch((error: unknown) => {
          if (error instanceof APIError && error.code === "conversation_archived")
            return { ...note, run: candidate.public_id }
          throw error
        })
      if (bound.run !== candidate.public_id) return
    }
    const active =
      this.gates.get(candidate.public_id)?.gate ??
      new UntilGate(
        policy,
        candidate.public_id,
        typeof this.timeoutSeconds === "function" ? this.timeoutSeconds() : this.timeoutSeconds,
      )
    this.gates.set(candidate.public_id, { workspace: candidate.workspace_public_id, gate: active })
    await active.reconsider(context, signal)
    if (active.done) this.gates.delete(candidate.public_id)
    return active
  }

  async scan(agents: readonly string[], signal: AbortSignal) {
    const states = [...new Set(agents)].map((agent) => ({
      agent,
      after: undefined as string | undefined,
      done: false,
      pending: undefined as RunCandidate[] | undefined,
      next: undefined as string | undefined,
      retryAt: 0,
    }))
    while (states.some((state) => !state.done)) {
      signal.throwIfAborted()
      for (const state of states.filter((state) => !state.done && state.retryAt <= Date.now())) {
        try {
          if (!state.pending) {
            const page = await this.client.work.runCandidates(
              { agent_public_id: state.agent, after: state.after },
              { signal },
            )
            state.pending = [...page.items]
            state.next = page.next_after ?? undefined
          } else {
            const row = state.pending[0]
            if (row)
              await this.recover(row, signal).catch((error: unknown) => {
                if (error instanceof APIError && [403, 404].includes(error.status)) return
                throw error
              })
            state.pending.shift()
          }
          if (state.pending.length === 0) {
            state.pending = undefined
            state.after = state.next
            state.done = state.after === undefined
          }
        } catch (error) {
          if (!(error instanceof APIError || error instanceof TransportError)) throw error
          const requested =
            error instanceof APIError
              ? Number(error.retryAfter) * 1000 || Date.parse(error.retryAfter ?? "") - Date.now() || 0
              : 0
          state.retryAt = Date.now() + Math.max(5000, requested)
        }
      }
      const remaining = states.filter((state) => !state.done)
      const delay = Math.min(...remaining.map((state) => state.retryAt)) - Date.now()
      if (remaining.length && delay > 0) await setTimeout(Math.min(delay, 30000), undefined, { signal })
    }
  }

  async watch(agents: readonly string[], signal: AbortSignal) {
    while (!signal.aborted) {
      await this.scan(agents, signal).catch((error: unknown) => {
        if (!(error instanceof APIError || error instanceof TransportError)) throw error
      })
      for (const [run, active] of this.gates) {
        await active.gate.reconsider(this.client.workspace(active.workspace).run(run), signal)
        if (active.gate.done) this.gates.delete(run)
      }
      await setTimeout(5000, undefined, { signal })
    }
  }

  private document(workspace: string, conversation: string) {
    return new StoreDocument(
      this.client.workspace(workspace).conversation(conversation).storeEntries,
      "opencode.nexus",
      "until",
      Schema.decodeUnknownSync(Note),
    )
  }
}
