import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { ExecutionSnapshot, Run } from "@cybros/agent"
import { modelRecoveryHint, repairableTasks } from "./execution"
import type { StoreDocument } from "./document"
import { TelegramError, TelegramUncertain } from "./telegram-api"
import type { TelegramState, TelegramWork } from "./telegram-state"
import type { TelegramTransport } from "./telegram-transport"

import { telegramPreview } from "./telegram-render"

const Sent = Schema.Struct({ message_id: Schema.Int })
type Preview = {
  document: StoreDocument<TelegramState>
  work: TelegramWork
  run: string
  draft: number
  status: string
  action?: string
  text?: string
  at?: number
  message?: number
  plain?: boolean
  disabled?: boolean
  terminal?: boolean
  typing?: number
  typingDisabled?: boolean
}
const headings: Record<string, string> = {
  pending: "Your request is queued.",
  queued: "Your request is queued.",
  running: "Working on your request.",
  waiting: "Waiting for your response.",
  needs_attention: "This request needs attention.",
  failed: "This request needs attention.",
  canceled: "Stopped.",
  stopped: "Stopped.",
  paused: "Paused.",
  completed: "Completed.",
  superseded: "This execution is no longer current.",
}

/** Replaceable previews are never formal answer receipts. */
export class TelegramProgress {
  private readonly held = new Map<string, Preview>()
  constructor(private readonly transport: (id: string) => TelegramTransport) {}

  observe(document: StoreDocument<TelegramState>, work: TelegramWork, snapshot: ExecutionSnapshot, detail?: Run) {
    const run = snapshot.execution.run_public_id
    if (!run) return
    const key = work.target.conversation + ":" + run
    const previous = this.held.get(key)
    if (!previous && snapshot.terminal) return
    for (const held of this.held.values()) {
      if (held.work.target.conversation === work.target.conversation && held.run !== run && !held.terminal)
        held.status = "superseded"
    }
    this.held.set(key, {
      ...previous,
      document,
      work,
      run,
      draft: Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 7), 16) + 1,
      action: detail ? telegramAction(detail) : undefined,
      status: snapshot.needs_attention ? "needs_attention" : (snapshot.run_status ?? snapshot.status ?? "pending"),
    })
  }

  async flush(connection: string, now: number) {
    for (const held of this.held.values()) {
      if (held.work.route.connection !== connection || held.terminal) continue
      const live = ["running", "pending", "queued", "waiting", "needs_attention", "paused"].includes(held.status)
      const route = held.work.route
      const transport = this.transport(route.connection)
      if (held.status === "running" && !held.typingDisabled && now - (held.typing ?? -Infinity) >= 5000) {
        held.typing = now
        await transport.typing(route, now).catch((error: unknown) => {
          if (error instanceof TelegramError && error.retryAfter === undefined) held.typingDisabled = true
        })
      }
      if (!live && !held.message) {
        held.terminal = true
        continue
      }
      if (held.disabled) continue
      const text = telegramPreview(
        (headings[held.status] ?? "Checking the request status.") + (held.action ? "\nNow: " + held.action : ""),
      )
      if (held.text === text && now - (held.at ?? 0) < 15000) continue
      const method = !route.group && !held.plain ? "sendMessageDraft" : held.message ? "editMessageText" : "sendMessage"
      try {
        const sent = await transport.send(
          route,
          now,
          async (api) => {
            if (method === "sendMessageDraft")
              await held.document.change((state) => ({
                ...state!,
                work: state!.work.map((work) =>
                  work.id === held.work.id ? { ...work, draft: { id: held.draft, run: held.run } } : work,
                ),
              }))
            return api.call(method, {
              chat_id: route.chat,
              ...(route.topic ? { message_thread_id: route.topic } : {}),
              ...(method === "sendMessageDraft"
                ? { draft_id: held.draft, can_stop: live }
                : held.message
                  ? { message_id: held.message }
                  : {}),
              text,
            })
          },
          true,
        )
        if (sent === undefined) continue
        if (method === "sendMessage") held.message = Schema.decodeUnknownSync(Sent)(sent).message_id
        held.text = text
        held.at = now
        held.terminal = !live
      } catch (error) {
        if (error instanceof TelegramError && error.retryAfter !== undefined) continue
        if (error instanceof TelegramError && !route.group && !held.plain) {
          held.plain = true
          continue
        }
        if (error instanceof TelegramError && error.code === 400 && error.notModified) {
          held.text = text
          held.at = now
          continue
        }
        if (!(error instanceof TelegramUncertain) || method === "sendMessage") held.disabled = true
      }
    }
  }
}

export function telegramAction(run: Run) {
  if (["failed", "needs_attention"].includes(run.status)) {
    const failed = repairableTasks(run)[0]
    if (failed) {
      const key = failed.error?.key
      const hint = modelRecoveryHint(key)
      if (hint) return hint
      if (["provider_model_unavailable", "model_unavailable"].includes(String(key)))
        return "The selected model provider is unavailable. Check its credentials and model settings in Nexus, then open the failed request in OpenCode to retry it."
      return "This request needs attention. Open the affected request in OpenCode to inspect and resolve it."
    }
  }
  const task = run.tasks.find((row) =>
    ["running", "dispatched", "awaiting_input", "needs_approval"].includes(row.status),
  )
  if (!task) return "Waiting for work"
  if (task.status === "needs_approval") return "Waiting for approval"
  if (task.status === "awaiting_input") return "Waiting for an answer"
  return task.kind === "model_task" ? "Thinking" : "Running a tool"
}
