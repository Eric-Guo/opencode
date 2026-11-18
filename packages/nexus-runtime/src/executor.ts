import type { RealtimeClient } from "@cybros/agent/realtime"
import { scheduler } from "node:timers/promises"
import { join } from "node:path"
import { RunnerInbox } from "./runner-inbox"
import { RunnerAdmission } from "./runner"
import { ClaimJournal } from "./claims"

export { RunnerAdmission } from "./runner"
export { ClaimJournal } from "./claims"
export type { RunnerContext, RunnerTool } from "./extensions"
export type { Orchestration, OperationHandle } from "./orchestration"

/** Experimental: may change without compatibility guarantees. Uses only the executor credential plane. */
export type ExecutorOptions = Omit<
  ConstructorParameters<typeof RunnerInbox>[0],
  "wake" | "signal" | "journal" | "admission"
> & {
  storage: string
  signal?: AbortSignal
  journal?: ClaimJournal
  admission?: RunnerAdmission
  realtime?: RealtimeClient
}

/** One reusable inbox owner for managed applications, custom runners and tool-provider hosts. */
export class NexusExecutor {
  private readonly owner = new AbortController()
  private readonly signal: AbortSignal
  private readonly inbox: RunnerInbox
  private wake = new AbortController()
  private work?: Promise<void>
  private closing?: Promise<void>

  constructor(private readonly options: ExecutorOptions) {
    this.signal = options.signal ? AbortSignal.any([options.signal, this.owner.signal]) : this.owner.signal
    this.inbox = new RunnerInbox({
      ...options,
      artifacts: options.artifacts ?? join(options.storage, "artifacts"),
      signal: this.signal,
      journal: options.journal ?? new ClaimJournal(join(options.storage, "claims")),
      admission: options.admission ?? new RunnerAdmission(),
      wake: () => this.wake.abort(),
    })
  }

  /** Follows HTTP recovery and optional realtime hints until close, interruption or authority loss. */
  start() {
    return (this.work ??= this.follow())
  }

  notify(message: unknown) {
    this.inbox.notify(message)
  }

  sweep() {
    return this.inbox.sweep()
  }

  drain() {
    return this.inbox.drain()
  }

  snapshot() {
    return this.inbox.snapshot()
  }

  setRoot(root: string) {
    this.inbox.setRoot(root)
  }

  close() {
    return (this.closing ??= (async () => {
      this.owner.abort()
      await this.options.realtime?.close()
      await this.inbox.close()
      await this.work
    })())
  }

  private async follow() {
    const notifications = this.listen()
    try {
      while (!this.signal.aborted) {
        this.wake = new AbortController()
        await this.inbox.sweep()
        await scheduler.wait(5000, { signal: AbortSignal.any([this.signal, this.wake.signal]) }).catch(() => {})
      }
    } finally {
      this.owner.abort()
      await this.inbox.close()
      await this.options.realtime?.close()
      await notifications
    }
  }

  private async listen() {
    const socket = this.options.realtime
    if (!socket) return
    while (!this.signal.aborted) {
      await socket
        .executorInbox({ signal: this.signal })
        .then(async (subscription) => {
          this.wake.abort()
          for await (const event of subscription) this.notify(event)
        })
        .catch(() => {})
      if (this.signal.aborted) return
      await socket.reconnect()
      await scheduler.wait(5000, { signal: this.signal }).catch(() => {})
    }
  }
}
