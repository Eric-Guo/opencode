import { claimProgress } from "./claim-progress"
import { FSUtil } from "@opencode/util/fs-util"
import { ClaimInterrupted, type CodeOperation } from "./claim-control"
import { bashOutput } from "./bash-output"
import { listDirectory } from "./runner-list"
import { codeBinding, codeInstructions } from "./code-settings"
import type { HostTools } from "./host"
import { constants, openAsBlob } from "node:fs"
import { Schema } from "effect"
import { open, mkdir, mkdtemp, rm, rename } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, sep, join } from "node:path"
import {
  type CommitTask,
  type AnnouncedTool,
  type ExecutorClient,
  type InboxTask,
  type JsonObject,
} from "@cybros/agent"

import type { Checkpoints } from "./checkpoints"
import type { RunnerContext, RunnerTool } from "./extensions"
import { webFetch } from "./web"
import { destination, mutate, mutateEditor } from "./mutation"
import { readablePath, readWindow, readEditorWindow, resolvePath } from "./file-read"
import { EditorBinding } from "./editor-bridge"
import { runnerSearch } from "./runner-search"
import { gitReview } from "./runner-git"
import { protectedPath, runnerRefusal } from "./runner-policy"
import { ToolInputError, toolFailure } from "./tool-error"

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
    effect_profile: readEffect,
    input_schema: { type: "object", properties: { upload: { type: "string" } }, required: ["upload"] },
  },
  {
    name: "grep",
    description: "Search project file contents with a regular expression and an optional file glob.",
    effect_profile: readEffect,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        include: { type: "string" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean" },
        context: { type: "integer", minimum: 0, maximum: 20 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["pattern"],
    },
  },
  {
    name: "find",
    description: "Find files by glob pattern, respecting ignore files. Returns paths relative to the search directory.",
    effect_profile: readEffect,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command using the user’s OpenCode shell, starting in the selected project. Commands can affect the machine outside the project.",
    effect_profile: { ...mutation, effect_scope: "open" },
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
        timeout: { type: "number", exclusiveMinimum: 0, maximum: 540 },
      },
      required: ["command"],
    },
  },
  {
    name: "write",
    description:
      "Create or replace a UTF-8 file, creating parent directories as needed. Paths may be relative or absolute.",
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
    description:
      "Read a text window or attach an image or PDF. Use offset/limit to continue large files. Paths may be relative or absolute.",
    effect_profile: readEffect,
    input_schema: {
      ...pathInput,
      required: ["path"],
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer", minimum: 1 } },
    },
  },
  {
    name: "code",
    description: codeInstructions,
    timeout_ms: 600000,
    effect_profile: {
      kind: "pure",
      destructive: false,
      effect_scope: "closed",
      idempotency: "intrinsic",
      reconciliation: "none",
    },
    input_schema: {
      $id: codeBinding,
      type: "object",
      properties: { code: { type: "string" }, params: {} },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "file_publish",
    description: "Publish a file from this directory as a downloadable attachment.",
    effect_profile: readEffect,
    input_schema: { ...pathInput, required: ["path"] },
  },
  {
    name: "ls",
    description: "List entries in a directory on the selected runner.",
    effect_profile: readEffect,
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
      required: [],
    },
  },
]

export const operatorTools: AnnouncedTool[] = [
  {
    name: "git_review",
    description: "Review Git changes from a pinned base with bounded, fingerprinted patches.",
    effect_profile: readEffect,
    input_schema: {
      type: "object",
      properties: {
        root: { type: "string" },
        base: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
        path: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  { name: "files_bytes", effect_profile: readEffect, input_schema: { ...pathInput, required: ["path"] } },
  {
    name: "checkpoints",
    effect_profile: readEffect,
    input_schema: {
      type: "object",
      properties: {
        store: { type: "string" },
        run_public_id: { type: "string" },
        checkpoint: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      additionalProperties: false,
    },
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
  if (typeof input.path !== "string" || !input.path) throw new ToolInputError("Expected a path.")
  return readablePath(root, input.path)
}

export async function execute(
  root: string,
  name: string | null,
  input: JsonObject,
  signal: AbortSignal,
): Promise<string> {
  if (name === "ls") return String((await listDirectory(root, input, signal)).content)
  const path = await runnerPath(root, input, signal)
  if (name !== "read") throw new Error("Unknown runner tool.")
  return (
    await readWindow(
      path,
      signal,
      typeof input.offset === "number" ? input.offset : undefined,
      typeof input.limit === "number" ? input.limit : undefined,
    )
  ).content
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
  operation?: CodeOperation,
  protectedRoots?: readonly string[],
  artifactsDirectory?: string,
  ports?: {
    read(workspace: string, anchor: string): EditorBinding | undefined
    drop(workspace: string, anchor: string, port: EditorBinding): void
  },
  startup?: Pick<RunnerContext, "executionStarted" | "started" | "workerRetired">,
  orchestration?: RunnerContext["orchestration"],
  bashTimeoutSeconds = 120,
): Promise<Omit<CommitTask, "claim_token">> {
  let editorNotice: string | undefined

  try {
    if (row.tool_name === "code" && orchestration) {
      if (typeof row.tool_input.code !== "string") throw new Error("Expected Code Mode source.")
      return await orchestration.run({ code: row.tool_input.code, params: row.tool_input.params })
    }
    if (row.tool_name === "code" && claimToken && operation) {
      if (typeof row.tool_input.code !== "string") throw new Error("Expected JavaScript source.")
      const task = executor.inboxTask(row.run_public_id, row.task_key)
      const { context, trace } = await task.operations(claimToken, {}, { signal })
      if (trace.length)
        throw new Error(
          "The previous execution state is unavailable; inspect its accepted work before starting a new invocation.",
        )
      const { runCode } = await import("./code")
      return await runCode(
        row.tool_input.code,
        row.tool_input.params ?? {},
        context.tools,
        operation,
        signal,
        context.model_defaults,
      )
    }
    if (row.tool_name === "file_import") {
      if (!claimToken) return { is_error: true, content: "Attachment import requires an active executor claim" }
      const match =
        typeof row.tool_input.upload === "string"
          ? /^(?:nexus:\/\/uploads\/)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
              row.tool_input.upload,
            )
          : null
      if (!match) return { is_error: true, content: "Expected a Nexus attachment reference or upload UUID" }
      const id = match[1].toLowerCase()
      const task = executor.inboxTask(row.run_public_id, row.task_key)
      const upload = await task.attachment(id, claimToken, { signal })
      const download = await task.attachmentBytes(id, claimToken, { signal })
      if (!download.body) throw new Error("Attachment has no content.")
      const dir = artifactsDirectory ?? (await destination(root, "nexus-attachments"))
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const folder = await mkdtemp(join(dir, "import-"))
      const filename =
        basename(upload.filename)
          .replace(/[^\p{L}\p{N}_.-]/gu, "_")
          .replace(/^\.+$/, "") || "attachment"
      const extension = extname(filename)
      const path = join(
        dir,
        id +
          "-" +
          Array.from(basename(filename, extension)).slice(0, 40).join("") +
          Array.from(extension).slice(0, 12).join(""),
      )
      const temporary = join(folder, "attachment.part")
      const file = await open(temporary, "wx", 0o600)
      try {
        let size = 0
        for await (const chunk of download.body) {
          signal.throwIfAborted()
          size += chunk.length
          if (size > upload.byte_size) throw new Error("Attachment changed during download.")
          await file.writeFile(chunk)
        }
        if (size !== upload.byte_size) throw new Error("Incomplete attachment.")
        await file.close()
        signal.throwIfAborted()
        await rename(temporary, path)
        return {
          content: `Imported ${upload.filename} (${upload.content_type}, ${upload.byte_size} bytes) to ${path}`,
          structured_content: {
            path,
            upload_public_id: id,
            filename: upload.filename,
            content_type: upload.content_type,
            byte_size: upload.byte_size,
          },
        }
      } catch (error) {
        signal.throwIfAborted()
        return {
          is_error: true,
          content: "Attachment import failed: " + (error instanceof Error ? error.message : String(error)),
        }
      } finally {
        await file.close()
        await rm(folder, { recursive: true, force: true })
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
    const progress = claimToken
      ? claimProgress(
          (text) =>
            executor.reportProgress(
              {
                run_public_id: row.run_public_id,
                task_key: row.task_key,
                claim_token: claimToken,
                text_tail: text,
              },
              { signal },
            ),
          signal,
        )
      : undefined
    const captured = row.executor_context?.["opencode.environment"] ?? row.executor_context?.["rho.environment"]
    const attachment = row.executor_context?.["opencode.mcp"] ?? captured
    const anchor =
      attachment === undefined
        ? undefined
        : Schema.decodeUnknownSync(Schema.Struct({ anchor: Schema.optional(Schema.NullOr(Schema.String)) }))(attachment)
            .anchor
    const extension = extensions.find((tool) => tool.definition.name === row.tool_name)
    if (extension)
      return await extension.execute(row.tool_input, {
        workspace: row.workspace_public_id,
        conversation: row.conversation_public_id,
        anchor,
        run: row.run_public_id,
        task: row.task_key,
        directory: root,
        artifacts: artifactsDirectory,
        signal,
        publish,
        ask,
        orchestration,
        ...startup,
        ...(claimToken
          ? {
              realtime: {
                read: () => executor.inboxTask(row.run_public_id, row.task_key).realtime(claimToken, { signal }),
                offer: (input) =>
                  executor.inboxTask(row.run_public_id, row.task_key).offerRealtime(claimToken, input, { signal }),
              },
              progress,
              processProgress: (frame: { process_id: string; lines?: string[]; exit?: number | null }) =>
                executor.reportProgress(
                  {
                    ...frame,
                    ...(row.conversation_public_id
                      ? { conversation_public_id: row.conversation_public_id }
                      : { run_public_id: row.run_public_id }),
                    source: { run_public_id: row.run_public_id, task_key: row.task_key, claim_token: claimToken },
                  },
                  { signal: AbortSignal.timeout(5000) },
                ),
            }
          : {}),
      })
    const descriptor = row.executor_context?.["opencode.editor"]
    const binding =
      anchor && ports
        ? ports.read(row.workspace_public_id, anchor)
        : descriptor === undefined
          ? undefined
          : Schema.decodeUnknownSync(EditorBinding)(descriptor)
    const selectedPath = typeof row.tool_input.path === "string" ? resolvePath(root, row.tool_input.path) : undefined
    const editor =
      binding &&
      selectedPath &&
      binding.roots.some((root) => {
        const path = relative(root, selectedPath)
        return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)
      })
        ? binding
        : undefined
    const filesystem =
      editor &&
      editorFilesystem(editor, signal, () => {
        if (anchor) ports?.drop(row.workspace_public_id, anchor, editor)
      })
    if (
      row.tool_name === "read" &&
      filesystem &&
      editor?.read &&
      typeof row.tool_input.path === "string" &&
      !/\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(row.tool_input.path)
    ) {
      const offset = typeof row.tool_input.offset === "number" ? Math.max(1, row.tool_input.offset) : 1
      const limit = typeof row.tool_input.limit === "number" ? row.tool_input.limit : 2000
      const result = await filesystem
        .read(resolvePath(root, row.tool_input.path), offset, limit + 1)
        .catch((error: unknown) => {
          signal.throwIfAborted()
          if (!(error instanceof EditorFailure)) throw error
          return error
        })
      if (!(result instanceof EditorFailure)) return await readEditorWindow(result, signal, offset, limit)
      if (result.code === "beyond_eof") return { is_error: true, content: `Offset ${offset} is beyond end of file.` }
      if (!["not_found", "unavailable"].includes(result.code))
        return { is_error: true, content: (editor.client ?? "The editor") + ": " + result.message }
      if (result.code !== "not_found")
        editorNotice =
          "[" + (editor.client ?? "The editor") + " did not answer the read (" + result.message + "); read from disk.]"
    }
    if (
      filesystem &&
      ((row.tool_name === "write" && editor?.write) || (row.tool_name === "edit" && editor?.read && editor.write))
    ) {
      const path = typeof row.tool_input.path === "string" ? await destination(root, row.tool_input.path) : ""
      const refusal = runnerRefusal(row.tool_name, { ...row.tool_input, path }, root, protectedRoots)
      if (refusal) return { is_error: true, content: refusal }
      const result = await mutateEditor(root, row.tool_name, row.tool_input, signal, filesystem).catch(
        (error: unknown) => {
          signal.throwIfAborted()
          if (!(error instanceof EditorFailure)) throw error
          return error
        },
      )
      if (!(result instanceof EditorFailure)) return result
      if (result.code !== "not_found" || (row.tool_name === "edit" && result.operation === "write"))
        return {
          is_error: true,
          content: (editor.client ?? "The editor") + " did not confirm the " + row.tool_name + ": " + result.message,
        }
    }
    if (row.tool_name === "ls") return await listDirectory(root, row.tool_input, signal)
    if (row.tool_name === "git_review") return await gitReview(root, row.tool_input, signal)
    if (row.tool_name === "checkpoints" || row.tool_name === "checkpoint_restore") {
      if (!checkpoints) return { is_error: true, content: "checkpoints_disabled: no store" }
      if (
        row.tool_input.store === undefined &&
        (row.tool_name === "checkpoint_restore" ||
          row.tool_input.checkpoint !== undefined ||
          row.tool_input.from !== undefined) &&
        !["opencode.environment", "rho.environment", "opencode.directory"].some(
          (key) => row.executor_context?.[key] !== undefined,
        )
      )
        return { is_error: true, content: "checkpoint_store_required: supply a store or captured environment" }
      try {
        if (row.tool_name === "checkpoints") return await checkpoints.query(row.tool_input, signal)
        if (typeof row.tool_input.checkpoint !== "string") throw new Error("Expected a checkpoint hash.")
        const selected =
          typeof row.tool_input.store === "string" ? await checkpoints.forStore(row.tool_input.store) : checkpoints
        if (!selected) return { is_error: true, content: "checkpoint_store_unknown: " + row.tool_input.store }
        return await selected.restore(row.tool_input.checkpoint, row.run_public_id, row.task_key, signal, host)
      } catch (error) {
        signal.throwIfAborted()
        return { is_error: true, content: error instanceof Error ? error.message : String(error) }
      }
    }
    if (row.tool_name === "web_fetch") {
      if (typeof row.tool_input.url !== "string") throw new ToolInputError("Expected a URL.")
      return await webFetch(row.tool_input.url, signal, publish)
    }
    if (row.tool_name === "bash") {
      if (!host || typeof row.tool_input.command !== "string" || !row.tool_input.command.trim())
        throw new ToolInputError("Expected a shell command.")
      const before = await host.capture(root, signal)
      const workdir =
        typeof row.tool_input.workdir === "string" && row.tool_input.workdir
          ? await readablePath(root, row.tool_input.workdir)
          : root
      const timeout = typeof row.tool_input.timeout === "number" ? row.tool_input.timeout : bashTimeoutSeconds
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 540)
        throw new ToolInputError("Timeout must be between 0 and 540 seconds.")
      const output = await host.shell(workdir, row.tool_input.command, signal, timeout * 1000, progress)
      const rendered = await bashOutput(output.file, signal, artifactsDirectory)
      const timedOut = output.structured_content.status === "timeout"
      const status = timedOut
        ? "Command timed out after " + timeout + " seconds"
        : output.structured_content.exit !== null && output.structured_content.exit !== 0
          ? "Command exited with code " + output.structured_content.exit
          : ""
      const text =
        (rendered.content || (timedOut ? "" : "(no output)")) +
        (status ? (rendered.content ? "\n\n" : "") + status : "")
      const content = rendered.spill
        ? [
            { type: "text", text },
            await publish(await openAsBlob(rendered.spill, { type: "text/plain" }), basename(rendered.spill)),
          ]
        : text
      const result = {
        content,
        is_error: timedOut || (output.structured_content.exit !== null && output.structured_content.exit !== 0),
        structured_content: {
          ...rendered.details,
          ...(output.structured_content.exit === null ? {} : { exit_status: output.structured_content.exit }),
        },
      }
      const after = before && (await host.capture(root, signal))
      if (!before || !after || before === after) return result
      const changes = await host.changes(root, before, after, signal)
      const truncated = changes.length > 50 || changes.some((change) => change.patch.length > 8192)
      return {
        ...result,
        structured_content: {
          ...result.structured_content,
          root,
          changes: changes.slice(0, 50).map((change) => ({ ...change, patch: change.patch.slice(0, 8192) })),
          truncated,
        },
      }
    }
    if (row.tool_name === "grep" || row.tool_name === "find") {
      return await runnerSearch(root, row.tool_name, row.tool_input, signal)
    }
    if (row.tool_name === "write" || row.tool_name === "edit") {
      const path = typeof row.tool_input.path === "string" ? await destination(root, row.tool_input.path) : ""
      const refusal = runnerRefusal(row.tool_name, { ...row.tool_input, path }, root, protectedRoots)
      if (refusal) return { is_error: true, content: refusal }
      return await mutate(root, row.tool_name, row.tool_input, signal)
    }
    if (row.tool_name === "read") {
      const path = await runnerPath(root, row.tool_input, signal)
      const media: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".pdf": "application/pdf",
      }
      const mime = media[extname(path).toLowerCase()]
      if (mime) {
        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
        try {
          const info = await file.stat()
          if (!info.isFile()) throw new ToolInputError("Select a regular attachment.")
          return {
            content: [
              { type: "text", text: basename(path) + ": attached" },
              await publish(await openAsBlob(path, { type: mime }), basename(path)),
            ],
          }
        } finally {
          await file.close()
        }
      }
      const result = await readWindow(
        path,
        signal,
        typeof row.tool_input.offset === "number" ? row.tool_input.offset : undefined,
        typeof row.tool_input.limit === "number" ? row.tool_input.limit : undefined,
      )
      return { ...result, content: editorNotice ? editorNotice + "\n\n" + result.content : result.content }
    }
    if (row.tool_name !== "file_publish" && row.tool_name !== "files_bytes")
      return { content: await execute(root, row.tool_name, row.tool_input, signal) }
    const path = await runnerPath(root, row.tool_input, signal)
    if (row.tool_name === "files_bytes" && protectedPath(path, root, protectedRoots))
      throw new ToolInputError("Refused: the path is inside protected runtime state.")
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new ToolInputError("Select a regular file.")
      signal.throwIfAborted()
      const file = await openAsBlob(path, { type: FSUtil.mimeType(path) })
      return {
        content: [
          { type: "text", text: `${path} (${file.type}, ${info.size} bytes)` },
          await publish(file, basename(path)),
        ],
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (extensions.some((tool) => tool.definition.name === row.tool_name)) throw error

    const result = toolFailure(error, signal)
    return { ...result, content: editorNotice ? editorNotice + "\n\n" + result.content : result.content }
  }
}

class EditorFailure extends Error {
  constructor(
    readonly code: string,
    readonly operation: "read" | "write",
    message: string,
  ) {
    super(message)
  }
}

function editorFilesystem(editor: EditorBinding, signal: AbortSignal, drop: () => void) {
  const request = async <S extends Schema.Decoder<unknown>>(
    operation: "read" | "write",
    input: JsonObject,
    schema: S,
  ) => {
    try {
      const response = await fetch(editor.url + "/fs/" + operation, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + editor.token },
        body: JSON.stringify({ session: editor.session, ...input }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(operation === "read" ? 30000 : 60000)]),
        redirect: "error",
      })
      const message = await response.text()

      signal.throwIfAborted()
      if (response.status === 200) {
        const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(message)
        if (parsed._tag === "Some") return parsed.value

        throw new EditorFailure("unavailable", operation, "Malformed editor " + operation + " response.")
      }
      const parsed = Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) })),
      )(message)
      // A structured root refusal is the editor's word; a bearer refusal or a broken response is a dead port.
      if (response.status === 401 || response.status < 400 || response.status >= 500 || parsed._tag === "None")
        throw new EditorFailure(
          "unavailable",
          operation,
          parsed._tag === "Some" ? parsed.value.error.message : `Editor returned HTTP ${response.status}.`,
        )
      if (parsed.value.error.code === "cancelled")
        throw new ClaimInterrupted(
          (editor.client ?? "The editor") + " cancelled the request: " + parsed.value.error.message,
        )

      throw new EditorFailure(
        ["closed", "timeout", "unavailable"].includes(parsed.value.error.code)
          ? "unavailable"
          : parsed.value.error.code,
        operation,
        parsed.value.error.message,
      )
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ClaimInterrupted) throw error

      const failure =
        error instanceof EditorFailure
          ? error
          : new EditorFailure("unavailable", operation, error instanceof Error ? error.message : String(error))
      if (failure.code === "unavailable") drop()

      throw failure
    }
  }

  return {
    async read(path: string, line?: number, limit?: number) {
      return (
        await request(
          "read",
          { path, ...(line === undefined ? {} : { line }), ...(limit === undefined ? {} : { limit }) },
          Schema.Struct({ content: Schema.String }),
        )
      ).content
    },
    async write(path: string, content: string) {
      await request("write", { path, content }, Schema.Record(Schema.String, Schema.MutableJson))
    },
  }
}
