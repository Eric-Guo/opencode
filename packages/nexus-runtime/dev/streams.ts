import { setTimeout } from "node:timers/promises"
import { TranscriptAccumulator, type Event, type JsonObject, type JsonValue, type ProgressFrame, type TranscriptItem } from "@cybros/agent"
import { Schema } from "effect"
import { ownsTranscript, type TranscriptIdentity } from "../src/execution"
import type { NexusApplication } from "../src/application"

const DirectReply = Schema.Struct({
  conversation: Schema.NonEmptyString,
  turn: Schema.NonEmptyString,
  variant: Schema.NonEmptyString,
})
const StreamCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["stream.open", "stream.attach"]),
    run: Schema.NonEmptyString,
    live: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("stream.open"),
    ...DirectReply.fields,
    live: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ action: Schema.Literals(["stream.poll", "stream.close"]), stream: Schema.NonEmptyString }),
  Schema.Struct({ action: Schema.Literal("stream.followers") }),
])
const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))
const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))
type Follower = {
  workspace: string
  turn: string | null
  variant: string | null
  run: string | null
  conversation: string | null
  events: { sequence: number; value: JsonObject; bytes: number }[]
  sequence: number
  lastReset: number
  bytes: number
  touched: number
  attached: boolean
  enableLive(): void
  text: TranscriptAccumulator
  reasoning: TranscriptAccumulator
  closing?: Promise<void>
  close(): Promise<void>
}

/** Shared, bounded daemon observations; a terminal's cancellation never changes kernel execution. */
export class DevelopmentStreams {
  private readonly followers = new Map<string, Follower>()
  private readonly streams = new Map<string, { follower: Follower; after: number }>()

  constructor(
    private readonly application: () => NexusApplication,
    private readonly signal: AbortSignal,
  ) {}

  followedRuns() {
    return [...this.followers.values()].flatMap((row) => (row.run ? [row.run] : []))
  }

  async observations() {
    const app = this.application()
    return Promise.all(
      [...this.followers.values()].map(async (row) => {
        const identity = { run: row.run, conversation: row.conversation, attached: row.attached }
        if (row.run)
          return { ...identity, ...(await app.operations.followerRun(row.workspace, row.run, { signal: this.signal })) }

        const turn = await app.client
          .workspace(row.workspace)
          .conversation(row.conversation!)
          .turns.variants(row.turn!, { signal: this.signal })
        const variant = turn.items.find((item) => item.public_id === row.variant)
        return { ...identity, status: variant?.status ?? "unavailable" }
      }),
    )
  }

  async command(value: unknown): Promise<JsonValue> {
    const input = Schema.decodeUnknownSync(StreamCommand)(value)
    if (input.action === "stream.followers")
      return [...this.followers.values()].map((row) => ({
        run: row.run,
        conversation: row.conversation,
        attached: row.attached,
      }))
    if (input.action === "stream.open" || input.action === "stream.attach") {
      const follower = await this.follow("run" in input ? input.run : input, input.live !== false)
      if (input.action === "stream.attach") {
        follower.attached = true
        return { run: input.run }
      }
      const id = crypto.randomUUID()
      this.streams.set(id, { follower, after: follower.sequence })
      return {
        stream: id,
        text: follower.text.text,
        text_length: follower.text.length,
        reasoning: follower.reasoning.text,
        reasoning_length: follower.reasoning.length,
      }
    }
    if (!("stream" in input)) throw new Error("Unknown development stream command.")
    const reader = this.streams.get(input.stream)
    if (!reader) throw new Error("Development stream is closed.")
    const row = reader.follower
    if (input.action === "stream.close") {
      this.streams.delete(input.stream)
      if (!row.attached && ![...this.streams.values()].some((reader) => reader.follower === row)) await row.close()
      return null
    }
    row.touched = performance.now()
    const events = row.events.filter((event) => event.sequence > reader.after)
    const lost = row.sequence - reader.after - events.length
    const reset = row.lastReset > reader.after
    reader.after = row.sequence
    return {
      events: events.map((event) => event.value),
      lost,
      ...(lost
        ? {
            reset,
            text: row.text.text,
            text_length: row.text.length,
            reasoning: row.reasoning.text,
            reasoning_length: row.reasoning.length,
          }
        : {}),
    }
  }

  private async follow(target: string | typeof DirectReply.Type, live: boolean) {
    const application = this.application()
    const workspace = await application.identity.workspace
    const run = typeof target === "string" ? target : null
    const turn =
      typeof target === "string"
        ? (await application.client.workspace(workspace).run(target).fetch({ signal: this.signal })).turn
        : { public_id: target.turn, conversation_public_id: target.conversation }
    const key = typeof target === "string" ? target : target.variant
    const existing = this.followers.get(key)
    if (existing && !existing.closing) {
      if (live) existing.enableLive()
      return existing
    }
    if (existing?.closing) await existing.closing
    const socket = application.realtime()
    const owner = new AbortController()
    const active = AbortSignal.any([this.signal, owner.signal])
    const jobs: Promise<void>[] = []
    let observingLive = false
    const row: Follower = {
      workspace,
      turn: turn?.public_id ?? null,
      variant: typeof target === "string" ? null : target.variant,
      run,
      conversation: turn?.conversation_public_id ?? null,
      events: [],
      sequence: 0,
      lastReset: 0,
      bytes: 0,
      touched: performance.now(),
      attached: false,
      enableLive() {
        if (observingLive) return
        observingLive = true
        jobs.push(watch("transcript"), watch("progress"))
      },
      text: new TranscriptAccumulator(),
      reasoning: new TranscriptAccumulator(),
      close: () => {
        if (row.closing) return row.closing
        row.closing = (async () => {
          for (const [id, reader] of this.streams) if (reader.follower === row) this.streams.delete(id)
          owner.abort()
          try {
            await socket.close()
            await Promise.allSettled(jobs)
          } finally {
            if (this.followers.get(key) === row) this.followers.delete(key)
          }
        })()
        return row.closing
      },
    }
    this.followers.set(key, row)
    const push = (value: JsonObject) => {
      if (value.channel === "transcript") {
        const frame = object(value.frame)
        const payload = object(frame.payload ?? {})
        if (frame.type === "stream_reset") {
          row.lastReset = row.sequence + 1
          row.text.reset()
          row.reasoning.reset()
        }
        if (frame.type === "text_delta" && typeof payload.text === "string") row.text.accumulate(payload.text)
        if (frame.type === "reasoning_delta" && typeof payload.text === "string") row.reasoning.accumulate(payload.text)
      }
      const bytes = Buffer.byteLength(JSON.stringify(value))
      row.sequence++
      if (bytes > 1024 * 1024) return
      while (row.events.length >= 512 || row.bytes + bytes > 1024 * 1024) row.bytes -= row.events.shift()!.bytes
      row.bytes += bytes
      row.events.push({ sequence: row.sequence, value, bytes })
    }
    const identity = {
      run_public_id: run,
      turn_public_id: turn?.public_id ?? null,
      variant_public_id: typeof target === "string" ? null : target.variant,
    }
    const methods = row.conversation
      ? ({
          events: "conversationEvents",
          transcript: "conversationTranscript",
          progress: "conversationProgress",
        } as const)
      : ({ events: "runEvents", transcript: "runTranscript", progress: "runProgress" } as const)
    const watch = async (channel: "events" | "transcript" | "progress") => {
      let reconnecting = false
      while (!active.aborted) {
        try {
          const subscription = await socket[methods[channel]](workspace, row.conversation ?? key, {
            signal: active,
          })
          if (reconnecting && channel === "transcript") push({ channel: "resync" })
          reconnecting = true
          for await (const frame of subscription) {
            if (row.conversation && !belongsToFollower(identity, frame)) continue
            push({ channel, frame: json(JSON.stringify(frame)) })
          }
        } catch (error) {
          if (active.aborted) return
          push({ channel: "notice", message: error instanceof Error ? error.message : String(error) })
        }
        await setTimeout(1000, undefined, { signal: active }).catch(() => {})
      }
    }
    jobs.push(watch("events"))
    if (live) row.enableLive()
    void (async () => {
      while (!active.aborted && (row.attached || performance.now() - row.touched < 60000))
        await setTimeout(10000, undefined, { signal: active }).catch(() => {})
      await row.close()
    })()
    return row
  }

  async release(conversation: string) {
    await Promise.allSettled(
      [...this.followers.values()].filter((row) => row.conversation === conversation).map((row) => row.close()),
    )
  }

  async close() {
    await Promise.allSettled([...this.followers.values()].map((row) => row.close()))
  }
}

function belongsToFollower(identity: TranscriptIdentity, frame: Event | TranscriptItem | ProgressFrame) {
  if ("variant_public_id" in frame) return ownsTranscript(identity, frame)
  if ("run_public_id" in frame) return !!frame.run_public_id && frame.run_public_id === identity.run_public_id

  // Durable events put the execution in their payload. A scheduled input can precede its turn.
  const payload = frame.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false
  if (payload.run_public_id) return payload.run_public_id === identity.run_public_id
  if (payload.variant_public_id)
    return (
      payload.variant_public_id === identity.variant_public_id && payload.turn_public_id === identity.turn_public_id
    )

  return (
    frame.type === "input_accepted" || (!!identity.turn_public_id && payload.turn_public_id === identity.turn_public_id)
  )
}
