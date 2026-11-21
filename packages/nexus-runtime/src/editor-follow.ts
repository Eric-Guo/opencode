import type { AgentContext, ToolCallContent, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk"
import {
  TranscriptAccumulator,
  type ExecutionIdentity,
  type ProgressFrame,
  type TaskDetail,
  type TranscriptItem,
} from "@cybros/agent"
import { resolve } from "node:path"
import { Schema } from "effect"

const Call = Schema.Struct({
  task_key: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  tool: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.NullOr(Schema.Boolean)),
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
    private readonly root: string,
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

  async call(run: string, call: typeof Call.Type, captured?: TaskDetail) {
    if (this.branches.has(run + ":" + call.task_key.replace(/t\d+$/, ""))) return

    const id = run + ":" + call.task_key
    const key = JSON.stringify([call.status, call.is_error === true, call.output_preview])
    const previous = this.tools.get(id)

    if (key === previous) return this.queue

    this.tools.set(id, key)
    const status: ToolCallStatus =
      call.is_error === true
        ? "failed"
        : call.status === "completed"
          ? "completed"
          : ["failed", "timed_out", "uncertain", "canceled", "skipped"].includes(call.status ?? "")
            ? "failed"
            : ["waiting", "needs_approval"].includes(call.status ?? "")
              ? "pending"
              : "in_progress"

    return this.send(async () => {
      const detail =
        previous === undefined
          ? (captured ?? (await this.detail?.(run, call.task_key).catch(() => undefined)))
          : undefined
      if (previous === undefined) {
        const identity = editorCall(call.task_key, detail, call)
        const input = identity.rawInput
        const path = typeof input.path === "string" && input.path ? resolve(this.root, input.path) : undefined
        const content: ToolCallContent[] = []
        const locations =
          detail?.task.target?.kind === "mcp" || (detail?.task.tool_name ?? call.tool ?? call.name)?.startsWith("mcp__")
            ? []
            : ["path", "file", "directory", "dir"].flatMap((field) => {
                const value = input[field]
                return typeof value === "string" && value ? [{ path: resolve(this.root, value) }] : []
              })

        if (identity.kind === "edit" && path) {
          const edits = Array.isArray(input.edits)
            ? input.edits
            : [{ oldText: input.oldText, newText: input.content ?? input.newText }]
          for (const edit of edits) {
            if (!edit || typeof edit !== "object" || Array.isArray(edit) || typeof edit.newText !== "string") continue
            content.push({
              type: "diff",
              path,
              newText: edit.newText,
              ...(typeof edit.oldText === "string" ? { oldText: edit.oldText } : {}),
            })
          }
        }

        await this.client.notify("session/update", {
          sessionId: this.session,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: id,
            ...identity,
            status,
            ...(locations.length ? { locations } : {}),
            ...(content.length ? { content } : {}),
          },
        })
      }
      const preview = call.output_preview ?? ((status === "failed" || status === "completed") && detail?.output_preview)
      if (previous !== undefined || preview)
        await this.client.notify("session/update", {
          sessionId: this.session,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status,
            ...(preview ? { content: [{ type: "content", content: { type: "text", text: preview } }] } : {}),
          },
        })
    })
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

export function editorCall(key: string, detail?: TaskDetail, call?: typeof Call.Type) {
  const rawInput = detail?.tool_input ?? {}
  const name = detail?.task.tool_name ?? call?.tool ?? call?.name ?? key
  const target = detail?.task.target
  const remote = target?.kind === "mcp"
  const callable = (remote && detail?.task.tool_alias) || name
  const argument = [
    ...["command", "pattern", "query", "url", "path", "prompt", "text", "name", "skill"].map((key) => rawInput[key]),
    ...Object.values(rawInput),
  ].find((value) => typeof value === "string" && value)
  const title =
    (!detail && call?.title) ||
    [callable, typeof argument === "string" && argument.split(/\r?\n/, 1)[0]].filter(Boolean).join(" ")
  const kind: ToolKind =
    remote || name.startsWith("mcp__")
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

  return {
    title: remote
      ? title +
        " (" +
        [target.display_name || target.connection_public_id, target.account_label, target.tool_name || name]
          .filter(Boolean)
          .join(" · ") +
        ")"
      : title,
    kind,
    rawInput,
  }
}
