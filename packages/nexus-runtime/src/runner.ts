import type { HostTools } from "./host"
import { constants } from "node:fs"
import { open, readdir, realpath, mkdir, mkdtemp, rm } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep, join } from "node:path"
import {
  type CommitTask,
  type AnnouncedTool,
  type ExecutorClient,
  type InboxTask,
  type JsonObject,
  type JsonValue,
} from "@cybros/agent"

import type { Checkpoints } from "./checkpoints"
import type { RunnerContext, RunnerTool } from "./extensions"
import { webFetch } from "./web"
import { destination, mutate, readText } from "./mutation"

export class RunnerAdmission {
  private resources = new Map<string, { concurrency: number; active: number }>()
  private listeners = new Set<() => void>()

  constructor(private readonly wake: () => void = () => {}) {}

  subscribe(wake: () => void) {
    this.listeners.add(wake)
    return () => this.listeners.delete(wake)
  }

  reserve(tool?: RunnerTool) {
    if (!tool?.resource) return () => {}

    const policy = tool.resource

    if (!Number.isSafeInteger(policy.concurrency) || policy.concurrency < 1)
      throw new Error("Resource concurrency must be a positive integer.")

    const resource = this.resources.get(policy.name) ?? { concurrency: policy.concurrency, active: 0 }

    if (resource.concurrency !== policy.concurrency) {
      if (resource.active) throw new Error("Inconsistent concurrency for " + policy.name)
      resource.concurrency = policy.concurrency
    }
    if (resource.active >= resource.concurrency) return

    this.resources.set(policy.name, resource)
    resource.active++

    return () => {
      resource.active--
      this.wake()
      this.listeners.forEach((wake) => wake())
    }
  }
}

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
    name: "file_import",
    description: "Materialize an attachment from this input in the project.",
    effect_profile: { ...mutation, destructive: false },
    input_schema: { type: "object", properties: { upload: { type: "string" } }, required: ["upload"] },
  },
  {
    name: "web_fetch",
    description: "Read a public HTTP(S) URL. Cross-site redirects require a separate call.",
    effect_profile: { ...readEffect, effect_scope: "open" },
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "grep",
    description: "Search project file contents with a regular expression and an optional file glob.",
    effect_profile: readEffect,
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, include: { type: "string" } },
      required: ["pattern"],
    },
  },
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
    description:
      "Run confined JavaScript with params and the tools declared for this input. Tool calls and nexus helpers return recorded outcome envelopes. Use text(), value() and resource() to select final output.",
    timeout_ms: 600000,
    effect_profile: { ...mutation, effect_scope: "open" },
    input_schema: {
      type: "object",
      properties: { code: { type: "string" }, params: { type: "object" } },
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

export const operatorTools: AnnouncedTool[] = [
  { name: "files_bytes", effect_profile: readEffect, input_schema: { ...pathInput, required: ["path"] } },
  {
    name: "checkpoints",
    effect_profile: readEffect,
    input_schema: { type: "object", properties: { run_public_id: { type: "string" } }, required: ["run_public_id"] },
  },
  {
    name: "checkpoint_restore",
    effect_profile: { ...readEffect, kind: "write", destructive: true, idempotency: "none" },
    input_schema: {
      type: "object",
      properties: { checkpoint: { type: "string" }, store: { type: "string" } },
      required: ["checkpoint"],
    },
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

export async function runClaim(
  executor: ExecutorClient,
  row: InboxTask,
  root: string,
  signal: AbortSignal,
  host?: HostTools,
  checkpoints?: Checkpoints,
  extensions: readonly RunnerTool[] = [],
  ask?: RunnerContext["ask"],
  claimToken?: string,
  operation?: (key: string, request: JsonObject) => Promise<JsonValue>,
): Promise<Omit<CommitTask, "claim_token">> {
  if (row.tool_name === "code" && claimToken && operation) {
    if (typeof row.tool_input.code !== "string") throw new Error("Expected JavaScript source.")
    const task = executor.inboxTask(row.run_public_id, row.task_key)
    const { context } = await task.operations(claimToken, {}, { signal })
    const { runCode } = await import("./code")
    return runCode(row.tool_input.code, row.tool_input.params ?? {}, context.tools, operation, signal)
  }
  if (row.tool_name === "file_import" && claimToken) {
    if (typeof row.tool_input.upload !== "string") throw new Error("Expected a Nexus upload ID.")
    const id = row.tool_input.upload.replace(/^nexus:\/\/uploads\//, "")
    if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id)) throw new Error("Invalid upload ID.")
    const task = executor.inboxTask(row.run_public_id, row.task_key)
    const upload = await task.attachment(id, claimToken, { signal })
    if (upload.byte_size > 16 * 1024 * 1024) throw new Error("Attachment exceeds 16 MiB.")
    const download = await task.attachmentBytes(id, claimToken, { signal })
    if (!download.body) throw new Error("Attachment has no content.")
    const dir = await destination(root, "nexus-attachments")
    await mkdir(dir, { recursive: true })
    const folder = await mkdtemp(join(dir, "import-"))
    const path = join(
      folder,
      basename(upload.filename)
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 120) || "attachment",
    )
    const file = await open(path, "wx", 0o600)
    try {
      let size = 0
      for await (const chunk of download.body) {
        signal.throwIfAborted()
        size += chunk.length
        if (size > upload.byte_size) throw new Error("Attachment changed during download.")
        await file.writeFile(chunk)
      }
      if (size !== upload.byte_size) throw new Error("Incomplete attachment.")
      return {
        content: relative(root, path),
        structured_content: { path: relative(root, path), upload_public_id: id, filename: upload.filename },
      }
    } catch (error) {
      await rm(folder, { recursive: true, force: true })
      throw error
    } finally {
      await file.close()
    }
  }
  const publish = async (blob: Blob, name: string) => {
    const file = await executor.uploads.create(blob, name, { signal })
    return {
      type: "resource_link",
      uri: "nexus://uploads/" + file.public_id,
      name: file.filename,
      mimeType: file.content_type,
      size: file.byte_size,
    }
  }
  const extension = extensions.find((tool) => tool.definition.name === row.tool_name)
  if (extension)
    return extension.execute(row.tool_input, {
      workspace: row.workspace_public_id,
      conversation: row.conversation_public_id,
      run: row.run_public_id,
      task: row.task_key,
      directory: root,
      signal,
      publish,
      ask,
      ...(claimToken
        ? {
            realtime: {
              read: () => executor.inboxTask(row.run_public_id, row.task_key).realtime(claimToken, { signal }),
              offer: (input) =>
                executor.inboxTask(row.run_public_id, row.task_key).offerRealtime(claimToken, input, { signal }),
            },
          }
        : {}),
    })
  if (row.tool_name === "checkpoints" && checkpoints && typeof row.tool_input.run_public_id === "string")
    return checkpoints.records(row.tool_input.run_public_id)
  if (row.tool_name === "checkpoint_restore" && checkpoints && typeof row.tool_input.checkpoint === "string") {
    if (row.tool_input.store !== undefined && row.tool_input.store !== root)
      throw new Error("Unknown checkpoint store.")
    return checkpoints.restore(row.tool_input.checkpoint, row.run_public_id, row.task_key, signal, host)
  }
  if (row.tool_name === "web_fetch") {
    if (typeof row.tool_input.url !== "string") throw new Error("Expected a URL.")
    return webFetch(row.tool_input.url, signal, publish)
  }
  if (row.tool_name === "bash") {
    if (!host || typeof row.tool_input.command !== "string" || !row.tool_input.command.trim())
      throw new Error("Expected a shell command.")
    const before = checkpoints && (await host.capture(root, signal))
    const result = await host.shell(root, row.tool_input.command, signal)
    const after = before && (await host.capture(root, signal))
    if (!checkpoints || !before || !after || before === after) return result
    const checkpoint = await checkpoints.save(row.run_public_id, row.task_key, { kind: "tree", before, after })
    const changes = await host.changes(root, before, after, signal)
    const truncated = changes.length > 50 || changes.some((change) => change.patch.length > 8192)
    return {
      ...result,
      metadata: { checkpoint },
      structured_content: {
        ...result.structured_content,
        root,
        changes: changes.slice(0, 50).map((change) => ({ ...change, patch: change.patch.slice(0, 8192) })),
        truncated,
      },
    }
  }
  if (row.tool_name === "grep") {
    const input = row.tool_input
    if (
      !host ||
      typeof input.pattern !== "string" ||
      (input.include !== undefined && typeof input.include !== "string")
    )
      throw new Error("Expected a search pattern and an optional include glob.")
    return { content: await host.grep(root, input.pattern, input.include, signal) }
  }
  if (row.tool_name === "find") {
    if (!host || typeof row.tool_input.query !== "string") throw new Error("Expected a filename query.")
    return { content: await host.find(root, row.tool_input.query, signal) }
  }
  if (row.tool_name === "write" || row.tool_name === "edit")
    return mutate(
      root,
      row.tool_name,
      row.tool_input,
      signal,
      checkpoints && ((change) => checkpoints.save(row.run_public_id, row.task_key, change)),
    )
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
    return { content: [await publish(new Blob([bytes]), basename(path))] }
  } finally {
    await handle.close()
  }
}
