import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { Client } from "@cybros/agent"
import { atomic, missing } from "./storage"

const Media = Schema.Struct({
  file_id: Schema.String,
  file_size: Schema.optional(Schema.Number),
  file_name: Schema.optional(Schema.String),
  mime_type: Schema.optional(Schema.String),
})
const Download = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ file_path: Schema.String, file_size: Schema.optional(Schema.Number) }),
})
const Message = Schema.Struct({
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  document: Schema.optional(Media),
  photo: Schema.optional(Schema.Array(Media)),
  audio: Schema.optional(Media),
  voice: Schema.optional(Media),
  reply_to_message: Schema.optional(Schema.Struct({ message_id: Schema.Number })),
  chat: Schema.Struct({ id: Schema.Number, type: Schema.String }),
  from: Schema.optional(Schema.Struct({ id: Schema.Number, first_name: Schema.String, is_bot: Schema.Boolean })),
})
const Updates = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Array(Schema.Struct({ update_id: Schema.Number, message: Schema.optional(Message) })),
})
const Sent = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Struct({ message_id: Schema.Number }) })
const State = Schema.Struct({
  offset: Schema.Number,
  staged: Schema.optional(Schema.Struct({ update: Schema.Number, upload: Schema.String })),
  conversations: Schema.Record(Schema.String, Schema.String),
  pending: Schema.Array(
    Schema.Struct({
      chat: Schema.String,
      conversation: Schema.String,
      input: Schema.String,
      attention: Schema.String,
      message: Schema.optional(Schema.Number),
    }),
  ),
})
type State = typeof State.Type

export async function telegram(
  options: {
    token: string
    chats: string[]
    directory: string
    file: string
    member: Client
    workspace: string
    agent: string
    runner: string
    signal: AbortSignal
  },
  transport: typeof fetch = fetch,
) {
  const { signal } = options
  const origin = "https://api.telegram.org/bot" + options.token + "/"
  const api = async (method: string, body: object) => {
    const response = await transport(origin + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    })
    if (!response.ok) throw new Error("Telegram returned HTTP " + response.status)
    return response.json()
  }
  const allowed = new Set(options.chats)
  const scope = options.member.workspace(options.workspace)
  let state: State = await readFile(options.file, "utf8")
    .then(Schema.decodeUnknownSync(Schema.fromJsonString(State)))
    .catch((error) => {
      if (missing(error)) return { conversations: {}, offset: 0, pending: [] }
      throw error
    })
  async function save(next: State) {
    await atomic(options.file, next)
    state = next
  }
  const key = (kind: string, id: string) => {
    const bytes = createHash("sha256")
      .update(JSON.stringify([options.agent, options.workspace, options.token.split(":")[0], kind, id]))
      .digest()
      .subarray(0, 16)
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return bytes.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
  }
  const send = async (id: string, text: string) => {
    const chunks = Array.from(text)
    let message = 0
    for (let at = 0; at < chunks.length; at += 4096) {
      const sent = Schema.decodeUnknownSync(Sent)(
        await api("sendMessage", { chat_id: id, text: chunks.slice(at, at + 4096).join("") }),
      )
      message = sent.result.message_id
    }
    return message
  }
  while (!signal.aborted) {
    try {
      const updates = Schema.decodeUnknownSync(Updates)(
        await api("getUpdates", {
          offset: state.offset,
          timeout: state.pending.length ? 1 : 12,
          allowed_updates: ["message"],
        }),
      )
      for (const update of updates.result) {
        const message = update.message
        const id = String(message?.chat.id)
        if (
          message &&
          (message.text || message.document || message.photo?.length || message.audio || message.voice) &&
          message.chat.type === "private" &&
          allowed.has(id) &&
          message.from &&
          !message.from.is_bot &&
          String(message.from.id) === id
        ) {
          let conversation = state.conversations[id]
          if (!conversation) {
            conversation = (
              await scope.conversations.create(
                {
                  title: "Telegram · " + message.from.first_name,
                  answering_user_public_id: options.agent,
                  default_runner_executor_public_id: options.runner,
                  metadata: { "opencode.surface": "telegram" },
                },
                { idempotencyKey: key("chat", id), signal },
              )
            ).conversation.public_id
          }
          const chat = scope.conversation(conversation)
          const text = message.text ?? message.caption ?? ""
          const command = /^\/(approve|deny|answer)(?:\s+([\s\S]+))?$/.exec(text)
          if (message.text === "/stop") await chat.cancel({ signal })
          else if (command) {
            const choices = state.pending.filter((item) => item.chat === id && item.attention)
            const pending = message.reply_to_message
              ? choices.find((item) => item.message === message.reply_to_message?.message_id)
              : choices.length === 1
                ? choices[0]
                : undefined
            const execution = pending && chat.inputExecution(pending.input)
            const decision =
              execution &&
              (await execution.recover({ signal }), await execution.decisions({ signal })).find(
                (item) => item.detail.task.key === pending.attention,
              )
            if (!decision)
              await send(
                id,
                choices.length ? "Reply to the specific request message with your decision." : "No pending decision.",
              )
            else if (decision.kind === "approval" && command[1] === "approve") await decision.task.approve({ signal })
            else if (decision.kind === "approval" && command[1] === "deny")
              await decision.task.deny(undefined, { signal })
            else if (decision.kind === "ask" && command[1] === "answer" && command[2])
              await decision.task.resolve({ content: command[2] }, { signal })
            else
              await send(
                id,
                "Use /approve or /deny for a tool request, or /answer followed by your answer for a question.",
              )
          } else {
            const speaker = await options.member.profile.registerIngressSpeaker(
              { channel_key: "telegram:" + options.agent, external_id: id, display_name: message.from.first_name },
              { signal },
            )
            const media = message.document ?? message.photo?.at(-1) ?? message.audio ?? message.voice
            let upload = state.staged?.update === update.update_id ? state.staged.upload : undefined
            if (media && !upload) {
              const limit = 16 * 1024 * 1024
              const info = Schema.decodeUnknownSync(Download)(await api("getFile", { file_id: media.file_id })).result
              if (Math.max(media.file_size ?? 0, info.file_size ?? 0) > limit) {
                await send(id, "This attachment exceeds the 16 MiB runner limit.")
                await save({ ...state, offset: update.update_id + 1 })
                continue
              }
              if (!/^[a-zA-Z0-9_./-]+$/.test(info.file_path) || info.file_path.split("/").includes(".."))
                throw new Error("Invalid Telegram download path.")
              const response = await transport(
                "https://api.telegram.org/file/bot" + options.token + "/" + info.file_path,
                { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: "error" },
              )
              if (!response.ok || !response.body) throw new Error("Telegram download failed.")
              const reader = response.body.getReader()
              const bytes: Uint8Array<ArrayBuffer>[] = []
              let size = 0
              try {
                while (true) {
                  const chunk = await reader.read()
                  if (chunk.done) break
                  size += chunk.value.length
                  if (size > limit) break
                  bytes.push(new Uint8Array(chunk.value))
                }
              } finally {
                await reader.cancel()
              }
              if (size > limit) {
                await send(id, "This attachment exceeds the 16 MiB runner limit.")
                await save({ ...state, offset: update.update_id + 1 })
                continue
              }
              const mime =
                media.mime_type ??
                (message.photo ? "image/jpeg" : message.voice ? "audio/ogg" : "application/octet-stream")
              const name = media.file_name ?? info.file_path.split("/").at(-1) ?? "attachment"
              upload = (await options.member.uploads.create(new Blob(bytes, { type: mime }), name, { signal }))
                .public_id
              await save({ ...state, staged: { update: update.update_id, upload } })
            }
            const receipt = await chat.inputs.create(
              {
                kind: "direct_reply",
                text: upload ? [text, "Attachment: nexus://uploads/" + upload].filter(Boolean).join("\n") : text,
                ...(upload ? { attachments: [upload] } : {}),
                speaker_public_id: speaker.public_id,
                approval_mode: "ask",
                executor_contexts: { [options.runner]: { "opencode.directory": options.directory } },
              },
              { idempotencyKey: key("input", String(update.update_id)), signal },
            )
            await save({
              ...state,
              offset: update.update_id + 1,
              staged: undefined,
              conversations: { ...state.conversations, [id]: conversation },
              pending: [...state.pending, { chat: id, conversation, input: receipt.input.public_id, attention: "" }],
            })
            continue
          }
        }
        await save({ ...state, offset: update.update_id + 1 })
      }
      for (const item of state.pending) {
        const execution = scope.conversation(item.conversation).inputExecution(item.input)
        const snapshot = await execution.recover({ signal })
        if (execution.blocked_reason || snapshot?.terminal) {
          await send(
            item.chat,
            snapshot?.content || execution.blocked_reason || snapshot?.failure_reason || "Reply finished.",
          )
          await save({ ...state, pending: state.pending.filter((row) => row.input !== item.input) })
        } else if (snapshot?.execution.run_public_id) {
          const decision = (await execution.decisions({ signal }))[0]
          if (decision && decision.detail.task.key !== item.attention) {
            const message = await send(
              item.chat,
              decision.kind === "approval"
                ? "Approve " +
                    decision.detail.task.tool_name +
                    "?\n" +
                    JSON.stringify(decision.detail.tool_input).slice(0, 3000) +
                    "\n/approve or /deny"
                : (decision.detail.prompt ?? "Answer requested") + "\n/answer <text>",
            )
            await save({
              ...state,
              pending: state.pending.map((row) =>
                row.input === item.input ? { ...row, attention: decision.detail.task.key, message } : row,
              ),
            })
          }
        }
      }
    } catch {
      if (!signal.aborted) await delay(3000, undefined, { signal }).catch(() => {})
    }
  }
}
