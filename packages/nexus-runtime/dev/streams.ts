import { setTimeout } from "node:timers/promises"
import { TranscriptAccumulator, type JsonObject, type JsonValue } from "@cybros/agent"
import { Schema } from "effect"
import type { NexusApplication } from "../src/application"

const StreamCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["stream.open", "stream.attach"]),
    run: Schema.NonEmptyString,
    live: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ action: Schema.Literals(["stream.poll", "stream.close"]), stream: Schema.NonEmptyString }),
  Schema.Struct({ action: Schema.Literal("stream.followers") }),
])
const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))
const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))
type Follower = {
  run: string
  conversation: string | null
  events: { sequence: number; value: JsonObject; bytes: number }[]
  sequence: number
  bytes: number
  touched: number
  attached: boolean
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

  async command(value: unknown): Promise<JsonValue> {
    const input = Schema.decodeUnknownSync(StreamCommand)(value)
    if (input.action === "stream.followers")
      return [...this.followers.values()].map((row) => ({
        run: row.run,
        conversation: row.conversation,
        attached: row.attached,
      }))
    if (input.action === "stream.open" || input.action === "stream.attach") {
      const follower = await this.follow(input.run, input.live !== false)
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
    const lost = Math.max(0, (row.events[0]?.sequence ?? row.sequence + 1) - reader.after - 1)
    reader.after = row.sequence
    return {
      events: events.map((event) => event.value),
      lost,
      ...(lost
        ? {
            text: row.text.text,
            text_length: row.text.length,
            reasoning: row.reasoning.text,
            reasoning_length: row.reasoning.length,
          }
        : {}),
    }
  }

  private async follow(run: string, live: boolean) {
    const application = this.application()
    const info = object(
      json(
        JSON.stringify(
          await application.operations.command({ action: "run", run, addressed: true }, { signal: this.signal }),
        ),
      ),
    )
    const existing = this.followers.get(run)
    if (existing && !existing.closing) return existing
    if (existing?.closing) await existing.closing
    const socket = application.realtime()
    const owner = new AbortController()
    const active = AbortSignal.any([this.signal, owner.signal])
    const jobs: Promise<void>[] = []
    const row: Follower = {
      run,
      conversation:
        typeof object(info.turn ?? {}).conversation_public_id === "string"
          ? String(object(info.turn).conversation_public_id)
          : null,
      events: [],
      sequence: 0,
      bytes: 0,
      touched: performance.now(),
      attached: false,
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
            if (this.followers.get(run) === row) this.followers.delete(run)
          }
        })()
        return row.closing
      },
    }
    this.followers.set(run, row)
    const push = (value: JsonObject) => {
      if (value.channel === "transcript") {
        const frame = object(value.frame)
        const payload = object(frame.payload ?? {})
        if (frame.type === "stream_reset") {
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
    const watch = async (channel: "events" | "transcript" | "progress") => {
      while (!active.aborted) {
        try {
          const options = { signal: active }
          const subscription = await (channel === "events"
            ? socket.runEvents(application.identity.workspace, run, options)
            : channel === "transcript"
              ? socket.runTranscript(application.identity.workspace, run, options)
              : socket.runProgress(application.identity.workspace, run, options))
          for await (const frame of subscription) push({ channel, frame: json(JSON.stringify(frame)) })
        } catch (error) {
          if (active.aborted) return
          push({ channel: "notice", message: error instanceof Error ? error.message : String(error) })
        }
        await setTimeout(1000, undefined, { signal: active }).catch(() => {})
      }
    }
    jobs.push(watch("events"), ...(live ? [watch("transcript"), watch("progress")] : []))
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
