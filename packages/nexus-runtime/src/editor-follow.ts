import type { AgentContext, ToolCallContent, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk"
import {
  TranscriptAccumulator,
  type ExecutionIdentity,
  type ProgressFrame,
  type TaskDetail,
  type TranscriptItem,
} from "@cybros/agent"
import { Schema } from "effect"

const Call = Schema.Struct({
  task_key: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  tool: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  output_preview: Schema.optional(Schema.NullOr(Schema.String)),
})

/** One Input owns this projection, including its automatic fallback executions and held questions. */
export class EditorTranscript {
  private identity?: ExecutionIdentity
  private sequence = 0
  private transcript = new TranscriptAccumulator()
  private tools = new Map<string, string>()
  private branches = new Set<string>()
  private queue = Promise.resolve()

  constructor(
    private readonly session: string,
    private readonly client: AgentContext,
    private readonly detail?: (run: string, task: string) => Promise<TaskDetail>,
  ) {}

  execution(identity: ExecutionIdentity) {
    if (this.identity && this.identity.run_public_id !== identity.run_public_id) {
      this.sequence++
      this.transcript.reset()
    }

    this.identity = identity
  }

  frame(frame: TranscriptItem) {
    if (!this.identity || frame.run_public_id !== this.identity.run_public_id) return Promise.resolve()
    if (frame.type === "round") {
      const round = Schema.decodeUnknownOption(Schema.Struct({ task_key: Schema.String, mainline: Schema.Boolean }))(
        frame.payload.round,
      )

      if (round._tag === "Some" && !round.value.mainline)
        this.branches.add(frame.run_public_id + ":" + round.value.task_key)
    }
    if (frame.type === "call") {
      const call = Schema.decodeUnknownOption(Call)(frame.payload.call)

      if (call._tag === "Some") return this.call(frame.run_public_id!, call.value)
    }
    if (frame.type === "stream_reset") {
      this.sequence++
      this.transcript.reset()
      return Promise.resolve()
    }
    if ((frame.type === "text_delta" || frame.type === "reasoning_delta") && typeof frame.payload.text === "string") {
      if (frame.type === "text_delta") this.transcript.accumulate(frame.payload.text)

      return this.message(frame.payload.text, frame.type === "reasoning_delta")
    }

    return Promise.resolve()
  }

  progress(frame: ProgressFrame) {
    if (!this.identity || frame.run_public_id !== this.identity.run_public_id || !frame.task_key)
      return Promise.resolve()
    if (frame.type === "round_started" && frame.payload.mainline === false)
      this.branches.add(frame.run_public_id + ":" + frame.task_key)
    if (!["step_started", "step_claimed", "task_progress"].includes(frame.type)) return Promise.resolve()

    return this.call(frame.run_public_id!, {
      task_key: frame.task_key,
      name: frame.tool_name,
      status: typeof frame.payload.status === "string" ? frame.payload.status : "running",
      output_preview: typeof frame.payload.text_tail === "string" ? frame.payload.text_tail : undefined,
    })
  }

  settle(text: string) {
    const suffix = this.transcript.replaceOnSettle(text)

    if (this.transcript.replaced) this.sequence++

    return this.message(suffix)
  }

  question(text: string) {
    return this.message(text)
  }

  async call(run: string, call: typeof Call.Type) {
    if (this.branches.has(run + ":" + call.task_key.replace(/t\d+$/, ""))) return

    const id = run + ":" + call.task_key
    const key = JSON.stringify([call.status, call.output_preview])
    const previous = this.tools.get(id)

    if (key === previous) return

    this.tools.set(id, key)
    const status: ToolCallStatus =
      call.status === "completed"
        ? "completed"
        : ["failed", "timed_out", "uncertain", "canceled", "skipped"].includes(call.status ?? "")
          ? "failed"
          : ["waiting", "needs_approval"].includes(call.status ?? "")
            ? "pending"
            : "in_progress"

    if (previous === undefined)
      await this.send(async () => {
        const detail = await this.detail?.(run, call.task_key).catch(() => undefined)
        const input = detail?.tool_input ?? {}
        const name = detail?.task.tool_name ?? call.tool ?? call.name ?? call.task_key
        const remote = detail?.task.target?.kind === "mcp" || name.startsWith("mcp__")
        const kind: ToolKind = remote
          ? "other"
          : /^(read|ls|read_process|list_processes|files_bytes|browser_snapshot|browser_screenshot)$/.test(name)
            ? "read"
            : /^(grep|find)$/.test(name)
              ? "search"
              : /^(write|edit)$/.test(name)
                ? "edit"
                : /^(bash|start_process|stop_process|checkpoint_restore)$/.test(name)
                  ? "execute"
                  : /^(web_fetch|browser_navigate)$/.test(name)
                    ? "fetch"
                    : "other"
        const content: ToolCallContent[] =
          !remote &&
          typeof input.path === "string" &&
          (name === "write" || name === "edit") &&
          typeof (input.content ?? input.newText) === "string"
            ? [
                {
                  type: "diff",
                  path: input.path,
                  newText: String(input.content ?? input.newText),
                  oldText: typeof input.oldText === "string" ? input.oldText : null,
                },
              ]
            : []

        await this.client.notify("session/update", {
          sessionId: this.session,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: id,
            title: call.title ?? name,
            kind,
            status,
            rawInput: input,
            ...(!remote
              ? {
                  locations: ["path", "file", "directory", "dir"].flatMap((key) =>
                    typeof input[key] === "string" ? [{ path: input[key] }] : [],
                  ),
                  content,
                }
              : {}),
          },
        })
      })
    if (previous !== undefined || call.output_preview)
      await this.send(() =>
        this.client.notify("session/update", {
          sessionId: this.session,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status,
            ...(call.output_preview
              ? { content: [{ type: "content", content: { type: "text", text: call.output_preview } }] }
              : {}),
          },
        }),
      )
  }

  private message(text: string, thought = false) {
    if (!text) return Promise.resolve()

    const messageId = (this.identity?.turn_public_id ?? this.session) + ":" + this.sequence

    return this.send(() =>
      this.client.notify("session/update", {
        sessionId: this.session,
        update: {
          sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
          messageId,
          content: { type: "text", text },
        },
      }),
    )
  }

  private send(action: () => Promise<void>) {
    const sent = this.queue.then(action)

    this.queue = sent.catch(() => {})
    return sent
  }
}
