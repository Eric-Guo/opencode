import {
  APIError,
  type ClaimedTask,
  type ExecutorClient,
  type JsonObject,
  type JsonValue,
  type OperationEvent,
} from "@cybros/agent"
import { setTimeout as delay } from "node:timers/promises"

type Task = ReturnType<ExecutorClient["inboxTask"]>

/** One granted deadline, independently maintained while its handler waits on child work. */
export class ClaimLease {
  private owner = new AbortController()
  private monitor = new AbortController()
  private deadline: number
  private renewAt: number
  private statusAt = Date.now() + 5000
  private timer?: ReturnType<typeof setTimeout>
  private work?: Promise<void>
  readonly signal: AbortSignal

  constructor(
    private readonly task: Task,
    private readonly claim: ClaimedTask,
    parent: AbortSignal,
    private readonly renewable = true,
  ) {
    this.deadline = claim.deadline_at ? Date.parse(claim.deadline_at) : Date.now() + 30000
    this.renewAt = renewable ? Date.now() + Math.max(0, this.deadline - Date.now()) / 2 : Infinity
    this.signal = AbortSignal.any([parent, this.owner.signal])
    this.arm()
  }

  start() {
    const signal = AbortSignal.any([this.signal, this.monitor.signal])

    this.work = (async () => {
      while (!signal.aborted) {
        await delay(Math.max(1, Math.min(this.statusAt, this.renewAt) - Date.now()), undefined, { signal })
        await this.maintain()
      }
    })().catch(() => {})
  }

  async maintain() {
    if (this.signal.aborted) return

    const signal = AbortSignal.any([this.signal, this.monitor.signal])

    if (Date.now() >= this.statusAt)
      await this.task.claimStatus(this.claim.claim_token, { signal }).then(
        (status) => {
          this.statusAt = Date.now() + 5000
          if (!status.active) this.owner.abort(new Error("Nexus claim is no longer active."))
        },
        (error: unknown) => {
          this.statusAt = Date.now() + Math.max(5000, retryDelay(error))
          if (error instanceof APIError && (error.status === 404 || error.code === "not_claimant"))
            this.owner.abort(new Error("Nexus claim is no longer owned by this runner."))
        },
      )

    if (!this.renewable || this.signal.aborted || Date.now() < this.renewAt) return

    const grant = await this.task
      .extend({ claim_token: this.claim.claim_token, timeout_ms: 3600000 }, { signal })
      .catch(() => undefined)

    if (!grant?.deadline_at) {
      // A refused renewal does not revoke the deadline Nexus already granted.
      this.renewAt = Infinity
      return
    }

    this.deadline = Date.parse(grant.deadline_at)
    this.renewAt = Date.now() + Math.max(0, this.deadline - Date.now()) / 2
    this.arm()
  }

  private arm() {
    clearTimeout(this.timer)

    if (this.deadline <= Date.now()) {
      this.owner.abort(new Error("Nexus claim deadline exceeded."))
      return
    }

    this.timer = setTimeout(
      () => this.owner.abort(new Error("Nexus claim deadline exceeded.")),
      Math.min(this.deadline - Date.now(), 2147483647),
    )
    this.timer.unref()
  }

  async close() {
    this.monitor.abort()
    clearTimeout(this.timer)
    await this.work
  }
}

export class OperationRefused extends Error {
  constructor(readonly refusal: { code: string; message: string }) {
    super(refusal.message)
  }
}

/** A single observation cursor distributes every recorded settlement to its actual operation. */
export class ClaimOperations {
  private pending = new Map<string, ReturnType<typeof Promise.withResolvers<JsonValue>>>()
  private outcomes = new Map<string, OperationEvent>()
  private position = 0
  private reading?: Promise<void>

  constructor(
    private readonly task: Task,
    private readonly token: string,
    private readonly signal: AbortSignal,
  ) {}

  async invoke(key: string, request: JsonObject) {
    if (this.pending.has(key) || this.outcomes.has(key)) throw new Error("Operation key already used: " + key)

    const pending = Promise.withResolvers<JsonValue>()

    this.pending.set(key, pending)
    // Attach rejection before the observation pump can deliver a refusal.
    void pending.promise.catch(() => {})

    await this.task
      .submit({ claim_token: this.token, operation: { key, request } }, { signal: this.signal })
      .catch(async (error: unknown) => {
        const receipt = await this.receipt(key)

        if (receipt) return receipt
        throw error
      })
      .then((accepted) => {
        if (accepted.refusal) throw new OperationRefused(accepted.refusal)
        this.reading ??= this.read().finally(() => {
          this.reading = undefined
        })
      })
      .catch((error: unknown) => {
        this.pending.delete(key)
        pending.reject(error)
      })

    return pending.promise
  }

  private async receipt(key: string) {
    let after = 0

    while (!this.signal.aborted) {
      const page = await this.task.operations(this.token, { after }, { signal: this.signal })

      for (const event of page.trace) {
        if (event.type === "observation") this.deliver(event)
      }

      const receipt = page.trace.find((event) => event.type === "operation" && event.key === key)

      if (receipt) return receipt
      if (page.next_after === null) return

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
    try {
      while (this.pending.size && !this.signal.aborted) {
        const result = await this.task
          .observe({ claim_token: this.token, after: this.position }, { signal: this.signal })
          .catch(async (error: unknown) => {
            if (error instanceof APIError && error.status < 500 && error.status !== 429) throw error

            await delay(retryDelay(error), undefined, { signal: this.signal })
            return undefined
          })

        if (!result) continue

        this.position = result.position

        if (result.observation) this.deliver(result.observation)
        else await delay(250, undefined, { signal: this.signal })
      }

      this.signal.throwIfAborted()
    } catch (error) {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
  }
}

function retryDelay(error: unknown) {
  if (!(error instanceof APIError) || !error.retryAfter) return 1000

  const seconds = Number(error.retryAfter)

  return Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(error.retryAfter) - Date.now()) || 1000
}
