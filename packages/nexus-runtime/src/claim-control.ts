import {
  APIError,
  CancelledError,
  TransportError,
  type ClaimedTask,
  type ExecutorClient,
  type JsonObject,
  type JsonValue,
  type OperationEvent,
} from "@cybros/agent"
import { isDeepStrictEqual } from "node:util"
import { scheduler } from "node:timers/promises"

type Task = ReturnType<ExecutorClient["inboxTask"]>

export class ClaimDeadline extends Error {}

export class ClaimInterrupted extends Error {}

/** Transport, throttle and 5xx failures are worth retrying under a live claim; typed refusals and local cancellation are final. */
export function transientControlError(error: unknown) {
  if (error instanceof CancelledError) return false
  return error instanceof TransportError || (error instanceof APIError && (error.status === 429 || error.status >= 500))
}

// The server's own count of the remaining park outranks deadline math on a skewed host clock.
function grantedDeadline(claim: Pick<ClaimedTask, "deadline_at" | "remaining_ms">) {
  if (typeof claim.remaining_ms === "number") return Date.now() + claim.remaining_ms
  return claim.deadline_at ? Date.parse(claim.deadline_at) : undefined
}

/** One granted deadline, independently maintained while its handler waits on child work. */
export class ClaimLease {
  private owner = new AbortController()
  private monitor = new AbortController()
  private deadline: number
  private renewAt: number
  private statusAt = Date.now() + 5000
  private timer?: ReturnType<typeof setTimeout>
  private clamp?: ReturnType<typeof setTimeout>
  private execution = new AbortController()
  private executionAt: number
  private work?: Promise<void>
  private wake = new AbortController()
  readonly signal: AbortSignal
  readonly executionSignal: AbortSignal

  constructor(
    private readonly task: Task,
    private readonly claim: ClaimedTask,
    parent: AbortSignal,
    private readonly renewable = true,
    private readonly extension = 3600000,
    private begun = true,
  ) {
    this.deadline = grantedDeadline(claim) ?? Infinity
    this.executionAt = this.deadline
    this.renewAt = renewable && begun ? Date.now() + Math.max(0, this.deadline - Date.now()) / 2 : Infinity
    this.signal = AbortSignal.any([parent, this.owner.signal])
    this.executionSignal = AbortSignal.any([this.signal, this.execution.signal])
    this.arm()
  }

  get deadlineAt() {
    return this.deadline
  }

  executionStarted() {
    if (this.begun || this.signal.aborted) return
    this.begun = true
    if (this.renewable) this.renewAt = Date.now() + Math.max(0, this.deadline - Date.now()) / 2
    this.wake.abort()
    this.wake = new AbortController()
  }

  start() {
    const signal = AbortSignal.any([this.signal, this.monitor.signal])

    this.work = (async () => {
      while (!signal.aborted) {
        await scheduler
          .wait(Math.max(1, Math.min(this.statusAt, this.renewAt) - Date.now()), {
            signal: AbortSignal.any([signal, this.wake.signal]),
          })
          .catch((error: unknown) => {
            if (signal.aborted) throw error
          })
        await this.maintain()
      }
    })().catch(() => {})
  }

  async maintain() {
    if (Date.now() >= this.deadline) this.owner.abort(new ClaimDeadline("Nexus claim deadline exceeded."))
    if (Date.now() >= this.executionAt) this.execution.abort(new ClaimDeadline("The tool's execution deadline passed."))
    if (this.signal.aborted) return
    if (this.executionSignal.aborted) this.renewAt = Infinity

    const signal = AbortSignal.any([this.signal, this.monitor.signal])

    if (Date.now() >= this.statusAt)
      await this.task.claimStatus(this.claim.claim_token, { signal }).then(
        (status) => {
          this.statusAt = Date.now() + 5000
          if (!status.active) this.owner.abort(new ClaimInterrupted("Nexus claim is no longer active."))
        },
        (error: unknown) => {
          this.statusAt = Date.now() + Math.max(5000, retryDelay(error))
          if (error instanceof APIError && (error.status === 404 || error.code === "not_claimant"))
            this.owner.abort(new ClaimInterrupted("Nexus claim is no longer owned by this runner."))
        },
      )

    if (!this.renewable || !this.begun || this.executionSignal.aborted || Date.now() < this.renewAt) return

    const answer = await this.task
      .extend({ claim_token: this.claim.claim_token, timeout_ms: Math.min(this.extension, 3600000) }, { signal })
      .then(
        (grant) => ({ grant }),
        (error: unknown) => ({ error }),
      )

    if ("error" in answer) {
      // A transient refusal retries while the wait still fits before the clamp; a typed refusal ends the asking.
      const wait = transientControlError(answer.error) ? Math.max(retryDelay(answer.error, 2000), 100) : 0
      this.renewAt = wait > 0 && Date.now() + wait < this.executionAt ? Date.now() + wait : Infinity
      return
    }

    const deadline = grantedDeadline(answer.grant)

    if (deadline === undefined) {
      // A refused renewal does not revoke the deadline Nexus already granted.
      this.renewAt = Infinity
      return
    }

    this.deadline = deadline
    this.renewAt = Date.now() + Math.max(0, this.deadline - Date.now()) / 2
    this.arm()
  }

  private arm() {
    clearTimeout(this.timer)
    clearTimeout(this.clamp)
    if (!Number.isFinite(this.deadline)) return

    const remaining = this.deadline - Date.now()
    this.executionAt = this.deadline - Math.min(15000, Math.max(0, remaining) / 4)
    this.clamp = setTimeout(
      () =>
        this.execution.abort(
          new ClaimDeadline(
            "The tool's execution deadline passed. Cancellation was requested; check its effects before retrying.",
          ),
        ),
      Math.max(0, this.executionAt - Date.now()),
    )
    this.clamp.unref()

    if (this.deadline <= Date.now()) {
      this.owner.abort(new ClaimDeadline("Nexus claim deadline exceeded."))
      return
    }

    this.timer = setTimeout(
      () => this.owner.abort(new ClaimDeadline("Nexus claim deadline exceeded.")),
      Math.min(this.deadline - Date.now(), 2147483647),
    )
    this.timer.unref()
  }

  async finishExecution() {
    this.monitor.abort()
    clearTimeout(this.clamp)
    await this.work
  }

  async close() {
    await this.finishExecution()
    clearTimeout(this.timer)
  }
}

export class OperationRefused extends Error {
  constructor(readonly refusal: { code: string; message: string }) {
    super(refusal.message)
  }
}

export type AcceptedOperation = { event: OperationEvent; outcome: Promise<JsonValue> }
export type CodeOperation = (key: string, request: JsonObject) => Promise<AcceptedOperation>

const OBSERVE_INITIAL_MS = 250
const OBSERVE_MAX_MS = 2000

/** One live invocation owns its receipts and observation cursor; source is never replayed. */
export class ClaimOperations {
  private pending = new Map<string, ReturnType<typeof Promise.withResolvers<JsonValue>>>()
  private outcomes = new Map<string, OperationEvent>()
  private position = 0
  private reading?: Promise<void>
  private wakeSignal = new AbortController()

  constructor(
    private readonly task: Task,
    private readonly token: string,
    private readonly signal: AbortSignal,
  ) {}

  /** Non-blocking hint that an observation may be ready; one pending wake is enough. */
  wake() {
    this.wakeSignal.abort()
  }

  async invoke(key: string, request: JsonObject) {
    return (await this.submit(key, request)).outcome
  }

  async question(key: string, request: JsonObject) {
    const trace = await this.history()
    const known = trace.find((event) => event.type === "operation" && event.key === key)
    if (!known) return this.invoke(key, request)
    this.match(known, key, request)
    const observed = trace.find((event) => event.type === "observation" && event.key === key)
    if (observed?.refusal) throw new OperationRefused(observed.refusal)
    if (observed) return observed.outcome
    return this.wait(known).outcome
  }

  async submit(key: string, request: JsonObject): Promise<AcceptedOperation> {
    this.signal.throwIfAborted()
    if (this.pending.has(key) || this.outcomes.has(key)) throw new Error("Operation key already used: " + key)
    const event = await this.accept(key, request)
    this.match(event, key, request)
    return this.wait(event)
  }

  private wait(event: OperationEvent): AcceptedOperation {
    const pending = Promise.withResolvers<JsonValue>()
    void pending.promise.catch(() => {})
    this.pending.set(event.key, pending)
    const observed = this.outcomes.get(event.key)
    if (observed) this.deliver(observed)
    this.pump()
    return { event, outcome: pending.promise }
  }

  private pump() {
    if (this.reading || !this.pending.size) return
    this.reading = this.read().finally(() => {
      this.reading = undefined
      this.pump()
    })
  }

  private async accept(key: string, request: JsonObject): Promise<OperationEvent> {
    this.signal.throwIfAborted()
    return this.task
      .submit({ claim_token: this.token, operation: { key, request } }, { signal: this.signal })
      .catch(async (error: unknown) => {
        this.signal.throwIfAborted()
        if (error instanceof APIError && error.code === "execution_paused") {
          await scheduler.wait(250, { signal: this.signal })
          return this.accept(key, request)
        }
        if (error instanceof APIError && error.status < 500) throw error
        const event = (await this.history()).find((event) => event.type === "operation" && event.key === key)
        if (event) return event
        throw error
      })
  }

  private match(event: OperationEvent, key: string, request: JsonObject) {
    if (event.type !== "operation" || event.key !== key || !isDeepStrictEqual(event.request, request))
      throw new Error("Accepted operation differs from the pending request.")
  }

  private async history(after = 0) {
    const trace: OperationEvent[] = []
    while (true) {
      this.signal.throwIfAborted()
      const page = await this.task.operations(this.token, { after }, { signal: this.signal })
      trace.push(...page.trace)
      if (page.next_after === null) return trace
      after = page.next_after
    }
  }

  private deliver(event: OperationEvent) {
    this.outcomes.set(event.key, event)
    const pending = this.pending.get(event.key)
    if (!pending) return
    this.pending.delete(event.key)
    if (event.refusal) pending.reject(new OperationRefused(event.refusal))
    else pending.resolve(event.outcome)
  }

  private async read() {
    let delay = OBSERVE_INITIAL_MS
    try {
      while (this.pending.size) {
        this.signal.throwIfAborted()
        const result = await this.task
          .observe({ claim_token: this.token, after: this.position }, { signal: this.signal })
          .catch(async (error: unknown) => {
            this.signal.throwIfAborted()
            if (error instanceof APIError && error.status === 429) {
              await scheduler.wait(retryDelay(error), { signal: this.signal })
              return
            }
            if (error instanceof APIError && error.code !== "operation_position_changed") throw error
            const trace = await this.history(this.position)
            if (!trace.length) throw error
            for (const event of trace) {
              this.position = Math.max(this.position, event.position)
              if (event.type === "observation") this.deliver(event)
            }
          })
        if (!result) continue
        this.position = result.position
        if (result.observation) {
          this.deliver(result.observation)
          delay = OBSERVE_INITIAL_MS
          continue
        }
        // A wake that landed during the read is spent: the read already saw the newest state.
        this.wakeSignal = new AbortController()
        await scheduler.wait(delay, { signal: AbortSignal.any([this.signal, this.wakeSignal.signal]) }).catch(() => {})
        delay = Math.min(delay * 2, OBSERVE_MAX_MS)
      }
    } catch (error) {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
  }
}

function retryDelay(error: unknown, fallback = 1000) {
  if (!(error instanceof APIError) || !error.retryAfter) return fallback

  const seconds = Number(error.retryAfter)

  return Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(error.retryAfter) - Date.now()) || fallback
}
