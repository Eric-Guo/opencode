import { setTimeout as delay } from "node:timers/promises"
import type { HostTools } from "./host"
import { constants } from "node:fs"
import { open, readdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import {
  APIError,
  type CommitTask,
  type AnnouncedTool,
  type ExecutorClient,
  type InboxTask,
  type JsonObject,
} from "@cybros/agent"

import type { ClaimJournal } from "./claims"
import { mutate, readText } from "./mutation"

const pathInput = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
} as const
export const readEffect = {
  kind: "read_only",
  destructive: false,
  effect_scope: "closed",
  idempotency: "intrinsic",
  reconciliation: "none",
} as const

const mutation = {
  kind: "write",
  destructive: true,
  effect_scope: "closed",
  idempotency: "none",
  reconciliation: "none",
} as const

export const tools: AnnouncedTool[] = [
  {
    name: "find",
    description: "Find project files by a partial filename or path.",
    effect_profile: readEffect,
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "bash",
    description:
      "Run a shell command using the user’s OpenCode shell, starting in the selected project. Commands can affect the machine outside the project.",
    effect_profile: { ...mutation, effect_scope: "open" },
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "write",
    description: "Create or replace a UTF-8 project file (up to 64 KiB).",
    effect_profile: mutation,
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Apply disjoint exact-text replacements in a project file. Each oldText must match once.",
    effect_profile: mutation,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { oldText: { type: "string" }, newText: { type: "string" } },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "read",
    description: "Read a UTF-8 text file in the selected runner directory.",
    effect_profile: readEffect,
    input_schema: { ...pathInput, required: ["path"] },
  },
  {
    name: "code",
    description: "Execute confined JavaScript with tools.read({path}) and tools.ls({path}). Return the result.",
    effect_profile: readEffect,
    input_schema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "file_publish",
    description: "Publish a file from this directory as a downloadable attachment.",
    effect_profile: {
      kind: "write",
      effect_scope: "open",
      destructive: false,
      idempotency: "none",
      reconciliation: "none",
    },
    input_schema: { ...pathInput, required: ["path"] },
  },
  {
    name: "ls",
    description: "List entries in a directory on the selected runner.",
    effect_profile: readEffect,
    input_schema: { ...pathInput, required: ["path"] },
  },
]

async function runnerPath(root: string, input: JsonObject, signal: AbortSignal) {
  signal.throwIfAborted()
  if (typeof input.path !== "string" || !input.path || Object.keys(input).length !== 1)
    throw new Error("Expected a path.")
  const path = await realpath(resolve(root, input.path))
  const rel = relative(root, path)
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Path is outside the runner directory.")
  return path
}

export async function execute(
  root: string,
  name: string | null,
  input: JsonObject,
  signal: AbortSignal,
): Promise<string> {
  if (name === "code") {
    if (typeof input.code !== "string") throw new Error("Expected code.")
    const { runCode } = await import("./code")
    return runCode(root, input.code, signal)
  }
  const path = await runnerPath(root, input, signal)
  if (name === "ls")
    return (await readdir(path, { withFileTypes: true }))
      .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
      .sort()
      .slice(0, 1000)
      .join("\n")
  if (name !== "read") throw new Error("Unknown runner tool.")
  return readText(path, signal)
}

async function runClaim(
  executor: ExecutorClient,
  row: InboxTask,
  root: string,
  signal: AbortSignal,
  host?: HostTools,
): Promise<Omit<CommitTask, "claim_token">> {
  if (row.tool_name === "bash") {
    if (!host || typeof row.tool_input.command !== "string" || !row.tool_input.command.trim())
      throw new Error("Expected a shell command.")
    return host.shell(root, row.tool_input.command, signal)
  }
  if (row.tool_name === "find") {
    if (!host || typeof row.tool_input.query !== "string") throw new Error("Expected a filename query.")
    return { content: await host.find(root, row.tool_input.query, signal) }
  }
  if (row.tool_name === "write" || row.tool_name === "edit") return mutate(root, row.tool_name, row.tool_input, signal)
  if (row.tool_name !== "file_publish" && row.tool_name !== "files_bytes")
    return { content: await execute(root, row.tool_name, row.tool_input, signal) }
  const path = await runnerPath(root, row.tool_input, signal)
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Select a regular file up to 16 MiB.")
    const bytes = new Uint8Array(info.size)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, offset, bytes.length - offset)
      if (!read.bytesRead) throw new Error("File changed during publication.")
      offset += read.bytesRead
    }
    const file = await executor.uploads.create(new Blob([bytes]), basename(path), { signal })
    return {
      content: [
        {
          type: "resource_link",
          uri: "nexus://uploads/" + file.public_id,
          name: file.filename,
          mimeType: file.content_type,
          size: file.byte_size,
        },
      ],
    }
  } finally {
    await handle.close()
  }
}

export async function serveInbox(
  executor: ExecutorClient,
  id: string,
  root: string,
  journal: ClaimJournal,
  signal: AbortSignal,
  host?: HostTools,
) {
  const addressed = (row: InboxTask) =>
    row.kind === "tool_call" && row.addressed_to?.role === "runner" && row.addressed_to.executor_public_id === id
  let after: string | undefined
  do {
    const page = await executor.inbox.list({ after }, { signal })
    for (const row of page.items.filter((row) => !row.claimed && addressed(row))) {
      const task = executor.inboxTask(row.run_public_id, row.task_key)
      const claim = await task.claim({ signal }).catch((error) => {
        if (error instanceof APIError && error.status === 409) return null
        throw error
      })
      if (!claim) continue
      const deadline = claim.deadline_at ? Date.parse(claim.deadline_at) - Date.now() : 30000
      if (deadline <= 0) continue
      const active = AbortSignal.any([signal, AbortSignal.timeout(Math.min(Math.ceil(deadline), 30000))])
      const binding = claim.task.executor_context?.["opencode.directory"]
      const valid =
        addressed(claim.task) &&
        claim.task.run_public_id === row.run_public_id &&
        claim.task.task_key === row.task_key &&
        (binding === root || (claim.task.tool_name === "files_bytes" && binding === undefined))
      const record = { run: row.run_public_id, task: row.task_key, token: claim.claim_token }
      await journal.save(record)
      const watch = new AbortController()
      const executing = AbortSignal.any([active, watch.signal])
      // A shell can outlive a Nexus cancellation notification. Recheck its claim while it runs.
      const monitor = (async () => {
        if (claim.task.tool_name !== "bash") return
        while (!executing.aborted) {
          await delay(750, undefined, { signal: executing })
          if (!(await task.claimStatus(claim.claim_token, { signal: executing })).active) watch.abort()
        }
      })().catch(() => watch.abort())
      const result = valid
        ? await runClaim(executor, claim.task, root, executing, host).then(
            (result) => ({ ...result, outcome: "completed" as const }),
            (cause) => ({
              content: cause instanceof Error ? cause.message : "Runner tool failed",
              outcome: "completed" as const,
              is_error: true,
            }),
          )
        : { content: "This claim does not match the captured runner directory.", outcome: "failed" as const }
      watch.abort()
      await monitor
      await journal.save({ ...record, result })
      if (signal.aborted) return
      if (!active.aborted && (await task.claimStatus(claim.claim_token, { signal: active })).active) {
        await task.commit({ claim_token: claim.claim_token, ...result }, { signal: active })
      }
      await journal.remove(record)
    }
    after = page.next_after ?? undefined
  } while (after !== undefined)
}
