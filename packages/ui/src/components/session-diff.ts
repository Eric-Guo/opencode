import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { formatPatch, parsePatch, structuredPatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type SnapshotDiff = SnapshotFileDiff & { file: string }
type ReviewDiff = SnapshotDiff | VcsFileDiff | LegacyDiff
export type DiffSource = Pick<LegacyDiff, "file" | "patch" | "before" | "after"> &
  Partial<Pick<LegacyDiff, "additions" | "deletions">>
type PatchData = {
  before: string
  after: string
  patch: string
  patchIsPartial: boolean
  fileDiff?: FileDiffMetadata
}

export type ViewDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const diffCacheLimit = 16
// Legacy before/after payloads do not include a patch. Bound exact diffing so pathological
// replacements cannot freeze the UI; oversized payloads still render as one coarse change hunk.
const contentDiffMaxEditLength = 2_000
const patchFileDiffCache = new Map<string, FileDiffMetadata>()
const contentPatchCache: { file: string; before: string; after: string; value: PatchData }[] = []

function mapCache<K, V>(cache: Map<K, V>, key: K) {
  const value = cache.get(key)
  if (value === undefined) return
  cache.delete(key)
  cache.set(key, value)
  return value
}

function setMapCache<K, V>(cache: Map<K, V>, key: K, value: V) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > diffCacheLimit) cache.delete(cache.keys().next().value!)
  return value
}

function patch(diff: DiffSource) {
  if (typeof diff.patch === "string") {
    return {
      before: "",
      after: "",
      patch: diff.patch,
      patchIsPartial: false,
    }
  }

  return patchFromContent(diff)
}

function patchFromContent(diff: DiffSource): PatchData {
  const file = diff.file
  const before = typeof diff.before === "string" ? diff.before : ""
  const after = typeof diff.after === "string" ? diff.after : ""
  const index = contentPatchCache.findIndex(
    (entry) => entry.file === file && entry.before === before && entry.after === after,
  )
  if (index !== -1) {
    const entry = contentPatchCache[index]!
    contentPatchCache.splice(index, 1)
    contentPatchCache.push(entry)
    return entry.value
  }

  const value = contentPatch(file, before, after, (diff.additions ?? 0) + (diff.deletions ?? 0))

  contentPatchCache.push({ file, before, after, value })
  while (contentPatchCache.length > diffCacheLimit) contentPatchCache.shift()
  return value
}

function contentPatch(file: string, before: string, after: string, changes: number): PatchData {
  const exact = changes > contentDiffMaxEditLength
    ? undefined
    : structuredPatch(file, file, before, after, "", "", {
        context: Number.MAX_SAFE_INTEGER,
        maxEditLength: contentDiffMaxEditLength,
      })

  if (exact) {
    const patch = formatPatch(exact)
    const fileDiff = parsePatchFiles(patch)[0]?.files[0]
    return {
      before,
      after,
      patch,
      patchIsPartial: false,
      fileDiff: fileDiff ? { ...fileDiff, isPartial: false } : coarseFileDiff(file, before, after),
    }
  }

  const fileDiff = coarseFileDiff(file, before, after)
  return {
    before,
    after,
    patch: coarsePatch(file, fileDiff),
    patchIsPartial: false,
    fileDiff,
  }
}

function coarseFileDiff(file: string, before: string, after: string): FileDiffMetadata {
  const deletionLines = patchLines(before).map((line) => line.value + (line.newline ? "\n" : ""))
  const additionLines = patchLines(after).map((line) => line.value + (line.newline ? "\n" : ""))
  const deletionCount = deletionLines.length
  const additionCount = additionLines.length

  return {
    name: file,
    type: deletionCount === 0 ? "new" : additionCount === 0 ? "deleted" : "change",
    hunks:
      deletionCount === 0 && additionCount === 0
        ? []
        : [
            {
              collapsedBefore: 0,
              splitLineCount: Math.max(deletionCount, additionCount),
              splitLineStart: 0,
              unifiedLineCount: deletionCount + additionCount,
              unifiedLineStart: 0,
              additionCount,
              additionStart: additionCount === 0 ? 0 : 1,
              additionLines: additionCount,
              deletionCount,
              deletionStart: deletionCount === 0 ? 0 : 1,
              deletionLines: deletionCount,
              deletionLineIndex: 0,
              additionLineIndex: 0,
              hunkContent: [
                {
                  type: "change",
                  additions: additionCount,
                  deletions: deletionCount,
                  additionLineIndex: 0,
                  deletionLineIndex: 0,
                },
              ],
              hunkSpecs: `@@ -${deletionCount === 0 ? 0 : 1},${deletionCount} +${additionCount === 0 ? 0 : 1},${additionCount} @@\n`,
              noEOFCRAdditions: additionCount > 0 && !after.endsWith("\n"),
              noEOFCRDeletions: deletionCount > 0 && !before.endsWith("\n"),
            },
          ],
    splitLineCount: Math.max(deletionCount, additionCount),
    unifiedLineCount: deletionCount + additionCount,
    isPartial: false,
    deletionLines,
    additionLines,
  }
}

function coarsePatch(file: string, diff: FileDiffMetadata) {
  const hunk = diff.hunks[0]
  if (!hunk) return `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n`
  return (
    [
      `Index: ${file}`,
      "===================================================================",
      `--- ${file}\t`,
      `+++ ${file}\t`,
      hunk.hunkSpecs?.trimEnd() ?? `@@ -1,${diff.deletionLines.length} +1,${diff.additionLines.length} @@`,
      ...diff.deletionLines.flatMap((line) => patchLine("-", line)),
      ...diff.additionLines.flatMap((line) => patchLine("+", line)),
    ].join("\n") + "\n"
  )
}

function patchLine(prefix: "-" | "+", line: string) {
  if (line.endsWith("\n")) return [prefix + line.slice(0, -1)]
  return [prefix + line, "\\ No newline at end of file"]
}

function patchLines(value: string) {
  if (!value) return []
  const parts = value.split("\n")
  const trailing = value.endsWith("\n")
  if (trailing) parts.pop()
  return parts.map((line, index) => ({
    value: line,
    newline: trailing || index < parts.length - 1,
  }))
}

function fileDiffFromPatch(patch: string) {
  const hit = mapCache(patchFileDiffCache, patch)
  if (hit) return hit

  let value: FileDiffMetadata | undefined
  const info = patchInfo(patch)
  if (info) {
    const file = parsePatchFiles(patch)[0]?.files[0]
    if (file) value = { ...file, isPartial: info.patchIsPartial }
  }
  if (value === undefined) value = parseDiffFromFile({ name: "", contents: "" }, { name: "", contents: "" })

  return setMapCache(patchFileDiffCache, patch, value)
}

function patchInfo(value: string) {
  try {
    return {
      patchIsPartial: parsePatch(value).every((file) => file.hunks.every((hunk) => hunk.oldStart > 1)),
    }
  } catch {
    return undefined
  }
}

function fileDiff(diff: DiffSource) {
  if (typeof diff.patch === "string") return fileDiffFromPatch(diff.patch)
  return patchFromContent(diff).fileDiff!
}

export function resolveFileDiff(diff: DiffSource) {
  return fileDiff(diff)
}

export function normalize(diff: ReviewDiff): ViewDiff {
  return {
    file: diff.file,
    get patch() {
      return patch(diff).patch
    },
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff: fileDiff(diff),
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}
