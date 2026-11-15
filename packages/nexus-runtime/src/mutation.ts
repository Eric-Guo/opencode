import { ToolInputError } from "./tool-error"
import { fileDiff } from "@opencode/core/tool/plugin/file-diff"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"
import { resolvePath } from "./file-read"

const Write = Schema.Struct({ path: Schema.NonEmptyString, content: Schema.String })
const Edit = Schema.Struct({
  path: Schema.NonEmptyString,
  edits: Schema.NonEmptyArray(Schema.Struct({ oldText: Schema.NonEmptyString, newText: Schema.String })),
})
const mutations = new Map<string, Promise<void>>()

// Resolve missing path components from the nearest existing parent before creating them.
export async function destination(root: string, file: string): Promise<string> {
  const path = resolvePath(root, file)
  const info = await lstat(path).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined
    throw cause
  })
  return info ? realpath(path) : join(await destination(root, dirname(path)), basename(path))
}

export async function mutate(
  root: string,
  name: "edit" | "write",
  input: JsonObject,
  signal: AbortSignal,
  checkpoint?: (change: {
    kind: "file"
    path: string
    before: string | null
    after: string
    mode: number
  }) => Promise<{ hash: string; store: string }>,
  restoreMode?: number,
) {
  signal.throwIfAborted()
  const decoded = Schema.decodeUnknownOption(name === "edit" ? Edit : Write)(input)
  if (decoded._tag === "None")
    throw new ToolInputError("invalid_tool_arguments: expected a path and valid file changes.")
  const request = decoded.value
  const path = await destination(root, request.path)
  const operation = (mutations.get(path) ?? Promise.resolve()).then(async () => {
    signal.throwIfAborted()
    if (path === root) throw new ToolInputError("Expected a regular file.")
    const info = await stat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if (info && !info.isFile()) throw new ToolInputError("Select a regular text file.")
    if (!info && name === "edit") throw new ToolInputError("Cannot edit a missing file.")
    const before = info ? await readText(path, signal) : ""
    const after = "edits" in request ? replace(before, request.edits) : request.content
    const file = relative(root, path)
    const status = info ? "modified" : "added"
    const change = fileDiff(file, before, after, status)
    const saved = await checkpoint?.({
      kind: "file",
      path: file,
      before: info ? before : null,
      after,
      mode: info?.mode ?? 0o666 & ~process.umask(),
    })
    if (!info || before !== after) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = join(dirname(path), ".opencode-nexus-" + crypto.randomUUID())
      const handle = await open(temporary, "wx", info ? info.mode & 0o777 : 0o666)
      try {
        await handle.writeFile(after, { signal })
        if (info || restoreMode !== undefined) await handle.chmod((restoreMode ?? info!.mode) & 0o777)
        await handle.close()
        signal.throwIfAborted()
        await rename(temporary, path)
      } finally {
        await handle.close()
        await rm(temporary, { force: true })
      }
    }
    return {
      ...(saved ? { metadata: { checkpoint: saved } } : {}),
      content: "Wrote " + Buffer.byteLength(after) + " bytes to " + path,
      structured_content: {
        root,
        change: {
          file: change.file,
          patch: change.patch,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
        },
      },
    }
  })
  const completed = operation.then(
    () => {},
    () => {},
  )
  mutations.set(path, completed)
  void completed.then(() => {
    if (mutations.get(path) === completed) mutations.delete(path)
  })
  return operation
}

export async function readText(path: string, signal: AbortSignal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new ToolInputError("Expected a regular file.")
    signal.throwIfAborted()
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await handle.readFile({ signal }))
  } finally {
    await handle.close()
  }
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘-‛]/g, "'")
    .replace(/[“-‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -   　]/g, " ")
}

function replace(raw: string, edits: readonly { oldText: string; newText: string }[]) {
  const bom = raw.startsWith("\ufeff") ? "\ufeff" : ""
  const original = raw.slice(bom.length).replace(/\r\n/g, "\n")
  const pairs = edits.map((edit) => ({
    oldText: edit.oldText.replace(/\r\n/g, "\n"),
    newText: edit.newText.replace(/\r\n/g, "\n"),
  }))
  const fuzzy = pairs.some((edit) => !original.includes(edit.oldText))
  const base = fuzzy ? normalize(original) : original
  const normalized = normalize(original)
  const matches = pairs
    .map((edit) => {
      const needle = fuzzy ? normalize(edit.oldText) : edit.oldText
      const check = normalize(edit.oldText)
      const start = base.indexOf(needle)
      if (!check || start < 0 || normalized.split(check).length !== 2)
        throw new ToolInputError(
          "Each edit must match exactly once in the original file, including normalized equivalents.",
        )
      return { start, end: start + needle.length, text: edit.newText }
    })
    .sort((a, b) => a.start - b.start)
  if (matches.some((match, index) => index > 0 && match.start < matches[index - 1].end))
    throw new ToolInputError("Edits overlap.")
  const apply = (text: string, selected: typeof matches, offset = 0) =>
    selected
      .toReversed()
      .reduce(
        (value, match) => value.slice(0, match.start - offset) + match.text + value.slice(match.end - offset),
        text,
      )
  const result = (() => {
    if (!fuzzy) return apply(base, matches)
    const originalLines = original.match(/[^\n]*\n|[^\n]+$/g) ?? []
    let offset = 0
    const spans = (base.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => {
      const start = offset
      offset += line.length
      return { start, end: offset }
    })
    if (originalLines.length !== spans.length)
      throw new ToolInputError("Cannot preserve unchanged lines after normalization.")
    const groups: { first: number; last: number; matches: typeof matches }[] = []
    for (const match of matches) {
      const first = spans.findIndex((line) => match.start >= line.start && match.start < line.end)
      const last = spans.findIndex((line) => match.end > line.start && match.end <= line.end)
      if (first < 0 || last < 0) throw new ToolInputError("Replacement lies outside the original content.")
      const previous = groups.at(-1)
      if (previous && first <= previous.last) {
        previous.last = Math.max(previous.last, last)
        previous.matches.push(match)
      } else groups.push({ first, last, matches: [match] })
    }
    let cursor = 0
    return (
      groups
        .map((group) => {
          const prefix = originalLines.slice(cursor, group.first).join("")
          cursor = group.last + 1
          const start = spans[group.first].start
          return prefix + apply(base.slice(start, spans[group.last].end), group.matches, start)
        })
        .join("") + originalLines.slice(cursor).join("")
    )
  })()
  if (result === original) throw new ToolInputError("The edits would not change the file.")
  const ending = raw.indexOf("\n") > 0 && raw[raw.indexOf("\n") - 1] === "\r" ? "\r\n" : "\n"
  return bom + result.replace(/\n/g, ending)
}

/** Editor buffers are authoritative while an ACP client advertises filesystem support. */
export async function mutateEditor(
  root: string,
  name: "edit" | "write",
  input: JsonObject,
  signal: AbortSignal,
  editor: { read(path: string): Promise<string>; write(path: string, content: string): Promise<void> },
) {
  const decoded = Schema.decodeUnknownOption(name === "edit" ? Edit : Write)(input)
  if (decoded._tag === "None")
    throw new ToolInputError("invalid_tool_arguments: expected a path and valid file changes.")
  const request = decoded.value
  const path = resolvePath(root, request.path)
  const operation = (mutations.get(path) ?? Promise.resolve()).then(async () => {
    signal.throwIfAborted()
    const after = "edits" in request ? replace(await editor.read(path), request.edits) : request.content
    signal.throwIfAborted()
    await editor.write(path, after)
    return { content: "Wrote " + Buffer.byteLength(after) + " bytes to " + path }
  })
  const completed = operation.then(
    () => {},
    () => {},
  )
  mutations.set(path, completed)
  void completed.then(() => {
    if (mutations.get(path) === completed) mutations.delete(path)
  })
  return operation
}
