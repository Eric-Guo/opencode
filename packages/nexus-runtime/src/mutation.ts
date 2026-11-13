import { fileDiff } from "@opencode/core/tool/plugin/file-diff"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"

const Write = Schema.Struct({ path: Schema.NonEmptyString, content: Schema.String })
const Edit = Schema.Struct({
  path: Schema.NonEmptyString,
  edits: Schema.NonEmptyArray(Schema.Struct({ oldText: Schema.NonEmptyString, newText: Schema.String })),
})
const limit = 65536

// Resolve missing path components from the nearest existing parent before creating them.
async function destination(root: string, file: string): Promise<string> {
  const path = resolve(root, file)
  const info = await lstat(path).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined
    throw cause
  })
  const target = info ? await realpath(path) : join(await destination(root, dirname(path)), basename(path))
  const rel = relative(root, target)
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Path is outside the runner directory.")
  return target
}

export async function mutate(root: string, name: "edit" | "write", input: JsonObject, signal: AbortSignal) {
  signal.throwIfAborted()
  const request = name === "edit" ? Schema.decodeUnknownSync(Edit)(input) : Schema.decodeUnknownSync(Write)(input)
  const path = await destination(root, request.path)
  if (path === root) throw new Error("Expected a regular file.")
  const info = await stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (info && (!info.isFile() || info.size > limit)) throw new Error("Select a regular text file up to 64 KiB.")
  if (!info && name === "edit") throw new Error("Cannot edit a missing file.")
  const before = info ? await readText(path, signal) : ""
  const after = "edits" in request ? replace(before, request.edits) : request.content
  if (Buffer.byteLength(after) > limit) throw new Error("File exceeds the 64 KiB write limit.")
  const file = relative(root, path)
  const status = info ? "modified" : "added"
  const change = fileDiff(file, before, after, status)
  if (!info || before !== after) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = join(dirname(path), ".opencode-nexus-" + crypto.randomUUID())
    const handle = await open(temporary, "wx", info ? info.mode & 0o777 : 0o666)
    try {
      await handle.writeFile(after, { signal })
      if (info) await handle.chmod(info.mode & 0o777)
      await handle.close()
      signal.throwIfAborted()
      await rename(temporary, path)
    } finally {
      await handle.close()
      await rm(temporary, { force: true })
    }
  }
  return {
    content: "Wrote " + Buffer.byteLength(after) + " bytes to " + file,
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
}

export async function readText(path: string, signal: AbortSignal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("Expected a regular file.")
    if (info.size > limit) throw new Error("File exceeds the 64 KiB read limit.")
    const bytes = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, offset, bytes.length - offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    if (offset === bytes.length) throw new Error("File exceeds the 64 KiB read limit.")
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

function replace(original: string, edits: readonly { oldText: string; newText: string }[]) {
  const matches = edits
    .map((edit) => {
      const start = original.indexOf(edit.oldText)
      if (start < 0 || original.indexOf(edit.oldText, start + 1) !== -1)
        throw new Error("Each edit must match exactly once in the original file.")
      return { start, end: start + edit.oldText.length, text: edit.newText }
    })
    .sort((a, b) => a.start - b.start)
  let offset = 0
  let result = ""
  for (const match of matches) {
    if (match.start < offset) throw new Error("Edits overlap.")
    result += original.slice(offset, match.start) + match.text
    offset = match.end
  }
  return result + original.slice(offset)
}
