import {
  APIError,
  BufferOverflow,
  RealtimeDisconnected,
  TransportError,
  type Client,
  type EventPosition,
  type InferenceRequest,
} from "@cybros/agent"
import type { RealtimeClient } from "@cybros/agent/realtime"
import type { InferenceCommand } from "@opencode/protocol/nexus-command"
import { scheduler } from "node:timers/promises"

type Lane = ReturnType<Client["workspace"]>["inferenceRequests"]

/** Follows standalone requests for the lifetime of one paired application. */
export class InferenceFollowers {
  private readonly rows = new Map<string, Map<string, InferenceFollower>>()
  private readonly creates = new Set<Promise<unknown>>()
  private socket?: RealtimeClient
  private closed = false

  constructor(
    private readonly member: Client,
    private readonly realtime?: () => RealtimeClient,
  ) {}

  async command(workspace: string, command: typeof InferenceCommand.Type) {
    if (this.closed) throw new Error("Nexus is disconnected.")
    if (command.action === "inference.list")
      return Array.from(this.rows.get(workspace)?.values() ?? [], (row) => row.snapshot())

    if (command.action !== "inference.create") {
      const row = this.rows.get(workspace)?.get(command.request)
      if (!row) throw new Error("This Agent is not following that inference request in this workspace.")
      const changed = row.setLive(command.action === "inference.subscribe")
      return { inference_request: row.snapshot(), changed }
    }

    const creating = this.create(workspace, command)
    this.creates.add(creating)
    try {
      return await creating
    } finally {
      this.creates.delete(creating)
    }
  }

  private async create(
    workspace: string,
    command: Extract<typeof InferenceCommand.Type, { action: "inference.create" }>,
  ) {
    const lane = this.member.workspace(workspace).inferenceRequests
    const receipt = await lane.create(
      {
        workload: command.workload ?? "text_generation",
        model: {
          model: command.model,
          reasoning_effort: command.reasoning_effort ?? undefined,
          reasoning_enabled: command.reasoning_enabled ?? undefined,
        },
        input: command.input,
        configuration: command.configuration ?? undefined,
        upload_public_ids: command.upload_public_ids ? [...command.upload_public_ids] : undefined,
        billing_subject: command.billing_subject ?? undefined,
        fallback_models: command.fallback_models ? [...command.fallback_models] : undefined,
        model_selection: command.model_selection
          ? {
              ...command.model_selection,
              alternatives: command.model_selection.alternatives
                ? [...command.model_selection.alternatives]
                : undefined,
            }
          : undefined,
      },
      { idempotencyKey: command.key },
    )
    const accepted = receipt.inference_request
    const rows = this.rows.get(workspace) ?? new Map<string, InferenceFollower>()
    const existing = rows.get(accepted.public_id)
    if (existing) return existing.snapshot()

    // A create accepted during disconnect still returns its locator to the submitting caller.
    const row = new InferenceFollower(
      lane,
      workspace,
      accepted,
      this.closed ? undefined : (this.socket ??= this.realtime?.()),
      command.live !== false,
    )
    if (!this.closed) {
      rows.set(accepted.public_id, row)
      this.rows.set(workspace, rows)
      row.start()
    }
    return row.snapshot()
  }

  async close() {
    this.closed = true
    const closing = Array.from(this.rows.values()).flatMap((rows) => Array.from(rows.values(), (row) => row.close()))
    this.rows.clear()
    await Promise.all([...closing, this.socket?.close(), Promise.allSettled(this.creates)])
  }
}

class InferenceFollower {
  private readonly stop = new AbortController()
  private readonly jobs = new Set<Promise<void>>()
  private reader?: AbortController
  private position: EventPosition = { sequence: 0, cursor: null }
  private text: string
  private status: string
  private result: InferenceRequest["result"]
  private issue?: string
  private live: boolean

  constructor(
    private readonly lane: Lane,
    private readonly workspace: string,
    private readonly accepted: InferenceRequest,
    private readonly socket: RealtimeClient | undefined,
    live: boolean,
  ) {
    this.live = !!socket && live
    this.result = accepted.result
    this.text = accepted.result?.output_text ?? ""
    this.status = accepted.result?.status ?? accepted.status
  }

  snapshot() {
    return {
      public_id: this.accepted.public_id,
      status: this.status,
      text: this.text,
      sequence: this.position.sequence,
      complete: !!this.result,
      result: this.result,
      live: this.live,
      ...(this.issue && { issue: this.issue }),
    }
  }

  start() {
    if (this.result) return
    this.readEvents()
    this.repeat(this.stop.signal, (signal) => this.readResult(signal))
  }

  setLive(live: boolean) {
    if (!this.socket || this.live === live || this.stop.signal.aborted || this.result) return false
    this.reader?.abort()
    this.live = live
    this.readEvents()
    return true
  }

  private readEvents() {
    this.reader = new AbortController()
    const active = AbortSignal.any([this.reader.signal, this.stop.signal])
    const socket = this.socket
    const id = this.accepted.public_id
    const items = this.live ? undefined : "lifecycle"
    this.repeat(active, async (signal) => {
      const feed = this.lane.feed(id, {
        signal,
        position: this.position,
        subscribe: socket ? (options) => socket.inferenceEvents(this.workspace, id, { ...options, items }) : undefined,
      })
      for await (const event of feed) {
        if (signal.aborted) return
        if (event.type === "result") {
          if (await this.readResult(signal)) this.position = { sequence: event.sequence, cursor: event.cursor }
          else if (!signal.aborted) throw new Error("Terminal inference event has no authoritative result.")
          return
        }
        if (event.type === "rollback") this.text = ""
        const value = event.payload
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (event.type === "text_delta" && typeof value.text === "string") this.text += value.text
          if (event.type === "run_status" && typeof value.status === "string") this.status = value.status
        }
        this.position = { sequence: event.sequence, cursor: event.cursor }
      }
    })
  }

  private async readResult(signal: AbortSignal) {
    const request = await this.lane.fetch(this.accepted.public_id, { signal })
    if (signal.aborted || !request.result) return false
    this.result = request.result
    this.text = request.result.output_text ?? ""
    this.status = request.result.status
    this.issue = undefined
    this.stop.abort()
    return true
  }

  private repeat(signal: AbortSignal, read: (signal: AbortSignal) => Promise<unknown>) {
    const follow = async () => {
      while (!signal.aborted) {
        let delay = 1000
        try {
          await read(signal)
        } catch (error) {
          if (signal.aborted) return
          if (error instanceof APIError && (error.status === 429 || error.status >= 500)) {
            delay = Math.max(
              delay,
              Number(error.retryAfter) * 1000 || Date.parse(error.retryAfter ?? "") - Date.now() || 0,
            )
          } else if (
            !(
              error instanceof TransportError ||
              error instanceof RealtimeDisconnected ||
              error instanceof BufferOverflow
            )
          ) {
            this.issue = error instanceof Error ? error.message : String(error)
            // A lost event cursor can still finish through the independent result poll.
            if (signal === this.stop.signal) this.stop.abort()
            return
          }
        }
        if (!signal.aborted) await scheduler.wait(delay, { signal }).catch(() => {})
      }
    }
    const job = follow().finally(() => this.jobs.delete(job))
    this.jobs.add(job)
  }

  async close() {
    this.stop.abort()
    await Promise.all(this.jobs)
  }
}
