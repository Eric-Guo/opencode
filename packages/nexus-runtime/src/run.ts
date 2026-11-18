import { executionSnapshot } from "./execution"
import { APIError, TransportError, type ExecutionIdentity, type JsonObject } from "@cybros/agent"
import { NexusRun } from "@opencode/schema/nexus-run"
import { Schema } from "effect"
import type { NexusApplication } from "./application"
import { setTimeout } from "node:timers/promises"

const ModelChange = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  reason: Schema.String,
  category: Schema.optional(Schema.String),
})
const ModelSwitch = Schema.Struct({ task: Schema.String, ...ModelChange.fields })
const ModelEvent = Schema.Struct({
  turn_public_id: Schema.String,
  variant_public_id: Schema.optional(Schema.NullOr(Schema.String)),
  run_public_id: Schema.optional(Schema.NullOr(Schema.String)),
  task_key: Schema.optional(Schema.String),
  model_change: Schema.optional(Schema.NullOr(ModelChange)),
  finish_quality: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  refusal_category: Schema.optional(Schema.NullOr(Schema.String)),
})

/** A one-shot caller owns cancellation; readers of existing work do not. */
export async function* runPrompt(
  application: NexusApplication,
  input: NexusRun.Input,
  signal: AbortSignal,
): AsyncGenerator<NexusRun.Event> {
  const started = performance.now()
  const timeout = input.timeout_ms ? AbortSignal.timeout(input.timeout_ms) : undefined
  const active = AbortSignal.any([signal, ...(timeout ? [timeout] : [])])
  const streams: Array<{ close(): Promise<void> }> = []
  const frames: NexusRun.Event[] = []
  const live = { run: "", bytes: 0 }
  const modelSwitches: JsonObject[] = []
  const refusals: JsonObject[] = []
  const state = {
    conversation: "",
    workspace: input.workspace ?? application.identity.workspace,
    turn: null as string | null,
    run: null as string | null,
    denied: 0,
    status: "failed",
    reason: null as string | null,
    content: null as string | null,
    exit: 1,
  }
  try {
    const opened = await application.open(
      { key: input.key + ":open", workspace: input.workspace, runner: input.runner, agent: input.agent },
      { signal: active },
    )
    state.conversation = opened.conversation.public_id
    const workspace = opened.conversation.workspace_public_id
    state.workspace = workspace
    const chat = application.client.workspace(workspace).conversation(state.conversation)
    if (input.code_mode !== undefined)
      await application.setModes(workspace, state.conversation, { code_mode: input.code_mode })
    if (input.directory) await application.environments.bind(workspace, state.conversation, { root: input.directory })
    const accepted = await application.submit(
      {
        key: input.key,
        workspace,
        conversation: state.conversation,
        text: input.prompt,
        ...(opened.conversation.answering_user_public_id !== application.identity.agent
          ? { addressed: true, answering_user_public_id: opened.conversation.answering_user_public_id }
          : {}),
        model: input.model,
        instructions: input.instructions,
        attachments: input.attachments ? [...input.attachments] : undefined,
        until: input.until,
      },
      undefined,
      { signal: active },
    )
    yield { type: "accepted", conversation_id: state.conversation, input_id: accepted.input.public_id }
    active.throwIfAborted()
    const execution = chat.inputExecution(accepted.input.public_id)
    const denied = new Set<string>()
    let previous = ""
    follow: while (!active.aborted) {
      const snapshot = await execution.recover({ signal: active }).then(executionSnapshot)
      if (execution.blocked_reason) {
        state.reason = execution.blocked_reason
        break
      }
      if (snapshot) {
        state.turn = snapshot.execution.turn_public_id
        state.run = snapshot.execution.run_public_id
        state.status = snapshot.status ?? "pending"
        state.content = snapshot.content
        if (state.run && live.run !== state.run && application.realtimeAvailable) {
          await Promise.allSettled(streams.map((stream) => stream.close()))
          streams.length = 0
          frames.length = 0
          live.bytes = 0
          live.run = state.run
          const socket = application.realtime()
          const stop = new AbortController()
          const watching = (async () => {
            const subscription = await socket.runTranscript(workspace, live.run, {
              signal: AbortSignal.any([active, stop.signal]),
            })
            for await (const frame of subscription) {
              const event = Schema.decodeUnknownSync(NexusRun.Event)({
                type: "transcript",
                run_id: live.run,
                frame: JSON.parse(JSON.stringify(frame)),
              })
              const bytes = Buffer.byteLength(JSON.stringify(event))
              if (live.bytes + bytes > 1024 * 1024) continue
              live.bytes += bytes
              frames.push(event)
            }
          })().catch(() => {})
          streams.push({
            close: async () => {
              stop.abort()
              await socket.close()
              await watching
            },
          })
        }
        while (frames.length) {
          const event = frames.shift()!
          live.bytes -= Buffer.byteLength(JSON.stringify(event))
          yield event
        }
        if (JSON.stringify(snapshot) !== previous) {
          previous = JSON.stringify(snapshot)
          yield { type: "snapshot", ...JSON.parse(previous) }
        }
        if (snapshot.terminal) {
          state.exit = snapshot.status === "completed" ? 0 : 1
          state.reason = snapshot.failure_reason
          break
        }
        if (snapshot.status === "failed" && !snapshot.terminal && !snapshot.needs_attention) {
          state.exit = 2
          state.reason = snapshot.failure_reason ?? "hold"
          break
        }
        if (snapshot.needs_attention) {
          const decisions = await execution.decisions({ signal: active })
          const approvals = decisions.filter((decision) => decision.kind === "approval")
          for (const decision of approvals) {
            const identity = state.run + ":" + decision.detail.task.key
            if (denied.has(identity)) continue
            const refusal = await decision.task
              .deny("opencode nexus run: non-interactive; nobody can approve", { signal: active })
              .then(
                () => undefined,
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              )

            active.throwIfAborted()
            if (refusal !== undefined) {
              state.exit = 2
              state.reason = (snapshot.attention?.reason ?? "approval_required") + " — " + refusal
              break follow
            }
            denied.add(identity)
            state.denied++
          }
          if (!approvals.length || decisions.some((decision) => decision.kind === "ask")) {
            state.exit = 2
            state.reason = snapshot.attention?.reason ?? "needs_person"
            break
          }
        }
      }
      await setTimeout(250, undefined, { signal: active })
    }
    active.throwIfAborted()
    if (execution.result && execution.snapshot)
      await readModelEvents(chat, execution.result, execution.snapshot.execution, modelSwitches, refusals, active)
  } catch (error) {
    state.reason = active.aborted
      ? timeout?.aborted
        ? "timeout"
        : "interrupted"
      : error instanceof Error
        ? error.message
        : "Run failed."
    state.exit = active.aborted ? (timeout?.aborted ? 2 : 130) : 1
  } finally {
    await Promise.allSettled(streams.map((stream) => stream.close()))
    if (state.conversation && (state.exit === 2 || active.aborted))
      await application.client
        .workspace(state.workspace)
        .conversation(state.conversation)
        .cancel({ signal: AbortSignal.timeout(5000) })
        .catch(() => {})
  }
  yield {
    type: "result",
    subtype:
      state.exit === 0
        ? "success"
        : state.exit === 2
          ? state.reason === "timeout"
            ? "timeout"
            : "needs_person"
          : state.exit === 130 || state.status === "canceled"
            ? "canceled"
            : "failed",
    is_error: state.exit !== 0,
    exit_status: state.exit,
    status: state.status,
    reason: state.reason,
    duration_ms: Math.round(performance.now() - started),
    denied_calls: state.denied,
    conversation_id: state.conversation,
    turn_id: state.turn,
    run_id: state.run,
    result: state.content,
    model_switches: modelSwitches,
    refusals,
  }
}

// Conversation-owned runs narrate on the conversation feed, including after the live text stream closes.
async function readModelEvents(
  chat: ReturnType<ReturnType<NexusApplication["client"]["workspace"]>["conversation"]>,
  original: ExecutionIdentity,
  selected: ExecutionIdentity,
  switches: JsonObject[],
  refusals: JsonObject[],
  active: AbortSignal,
) {
  const signal = AbortSignal.any([active, AbortSignal.timeout(3000)])
  const variants = new Set([original.variant_public_id, selected.variant_public_id])
  const runs = new Set([original.run_public_id, selected.run_public_id])

  if (original.variant_public_id !== selected.variant_public_id) {
    const deck = await chat.turns.variants(original.turn_public_id, { signal }).catch(() => undefined)
    const byID = new Map(deck?.items.map((variant) => [variant.public_id, variant]))
    const seen = new Set<string>()
    let variant = selected.variant_public_id ? byID.get(selected.variant_public_id) : undefined

    while (variant?.source === "fallback" && !seen.has(variant.public_id)) {
      seen.add(variant.public_id)
      variant = variant.origin_variant_public_id ? byID.get(variant.origin_variant_public_id) : undefined
      if (!variant) break

      variants.add(variant.public_id)
      runs.add(variant.run_public_id)
    }
  }

  let after: string | undefined
  let sequence = -1
  do {
    const read = () => chat.events({ after, limit: 200 }, { signal })
    const page = await read().catch((error: unknown) =>
      error instanceof TransportError || (error instanceof APIError && error.status >= 500)
        ? read().catch(() => undefined)
        : undefined,
    )

    if (!page) break

    for (const event of page.items) {
      if (event.sequence <= sequence) continue
      sequence = event.sequence
      if (!["task_status", "turn_created", "turn_status", "round_result"].includes(event.type)) continue
      const decoded = Schema.decodeUnknownOption(ModelEvent)(event.payload)

      if (decoded._tag === "None") continue
      const row = decoded.value

      if (row.turn_public_id !== original.turn_public_id) continue
      if (row.run_public_id && !runs.has(row.run_public_id)) continue
      if (row.variant_public_id && !variants.has(row.variant_public_id)) continue
      if (!row.run_public_id && !row.variant_public_id) continue

      const task = row.task_key ?? "reply"
      if (event.type !== "round_result" && row.model_change) switches.push({ task, ...row.model_change })
      if (
        (event.type === "round_result" || event.type === "turn_status") &&
        (row.finish_quality === "refused" || row.finish_quality === "blocked")
      )
        refusals.push({
          task,
          ...(row.model ? { model: row.model } : {}),
          ...(row.refusal_category ? { category: row.refusal_category } : {}),
        })
    }
    if (!page.next_after || page.next_after === after) break
    after = page.next_after
  } while (!signal.aborted)
}

/** Both live frames and durable snapshots feed one output cursor. */
export class RunOutput {
  private text = ""

  constructor(
    private readonly options: {
      format: "text" | "json" | "stream-json"
      print: boolean
      write(text: string): void
      error(text: string): void
    },
  ) {}

  accept(event: NexusRun.Event) {
    if (this.options.format === "stream-json" || (this.options.format === "json" && event.type === "result"))
      this.options.write(JSON.stringify(event) + "\n")
    if (this.options.format === "text" && !this.options.print) {
      if (event.type === "accepted") this.options.write("conversation: " + event.conversation_id + "\n")
      if (event.type === "transcript") {
        const frame = Schema.decodeUnknownSync(
          Schema.Struct({ type: Schema.String, payload: Schema.Record(Schema.String, Schema.Json) }),
        )(event.frame)
        if (frame.type === "stream_reset") {
          this.text = ""
          this.options.write("\n(restarted)\n")
        }
        if (frame.type === "text_delta" && typeof frame.payload.text === "string") {
          this.text += frame.payload.text
          this.options.write(frame.payload.text)
        }
      }
      if (
        event.type === "snapshot" &&
        typeof event.content === "string" &&
        (event.terminal || event.content.startsWith(this.text))
      )
        this.snapshot(event.content)
    }
    if (event.type !== "result") return
    if (this.options.format === "text") {
      const switches = Schema.decodeUnknownOption(Schema.Array(ModelSwitch))(event.model_switches)

      if (switches._tag === "Some")
        for (const change of switches.value) {
          const text =
            change.task +
            " switched from " +
            change.from +
            " to " +
            change.to +
            " (" +
            change.reason +
            (change.category ? ": " + change.category : "") +
            ")\n"
          if (this.options.print) this.options.error("opencode nexus run: " + text)
          else this.options.write("\n" + text)
        }
      if (this.options.print) this.options.write(String(event.result ?? "") + "\n")
      if (!this.options.print) {
        this.snapshot(String(event.result ?? ""))
        this.options.write("\n")
      }
      if (event.is_error && event.reason) this.options.error("opencode nexus run: " + event.reason + "\n")
    }
    return typeof event.exit_status === "number" ? event.exit_status : 1
  }

  private snapshot(text: string) {
    const delta = text.startsWith(this.text) ? text.slice(this.text.length) : "\n(restarted)\n" + text
    this.options.write(delta)
    this.text = text
  }
}
