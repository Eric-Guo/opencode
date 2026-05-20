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
export type DiffSource = Pick<LegacyDiff, "file" | "patch" | "before" | "after">
type PatchData = {
  before: string
  after: string
  patch: string
  patchIsPartial: boolean
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
const fileDiffCache = new Map<string, FileDiffMetadata>()
const patchTextCache = new Map<string, PatchData>()
// Keep this before structuredPatch/formatPatch; those dominate huge diff metadata updates.
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
    return patchFromText(diff.patch)
  }

  return patchFromContent(
    diff.file,
    typeof diff.before === "string" ? diff.before : "",
    typeof diff.after === "string" ? diff.after : "",
  )
}

function patchFromText(value: string): PatchData {
  const cached = mapCache(patchTextCache, value)
  if (cached) return cached

  return setMapCache(patchTextCache, value, parsePatchText(value))
}

function parsePatchText(value: string): PatchData {
  try {
    const [patch] = parsePatch(value)
    const beforeLines: Array<{ text: string; newline: boolean }> = []
    const afterLines: Array<{ text: string; newline: boolean }> = []
    let previous: "-" | "+" | " " | undefined

    const patchIsPartial = patch.hunks.every((h) => h.oldStart > 1)

    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("\\")) {
          if (previous === "-" || previous === " ") {
            const before = beforeLines.at(-1)
            if (before) before.newline = false
          }
          if (previous === "+" || previous === " ") {
            const after = afterLines.at(-1)
            if (after) after.newline = false
          }
          continue
        }

        if (line.startsWith("-")) {
          beforeLines.push({ text: line.slice(1), newline: true })
          previous = "-"
        } else if (line.startsWith("+")) {
          afterLines.push({ text: line.slice(1), newline: true })
          previous = "+"
        } else {
          // context line (starts with ' ')
          beforeLines.push({ text: line.slice(1), newline: true })
          afterLines.push({ text: line.slice(1), newline: true })
          previous = " "
        }
      }
    }

    return {
      before: beforeLines.map((line) => line.text + (line.newline ? "\n" : "")).join(""),
      after: afterLines.map((line) => line.text + (line.newline ? "\n" : "")).join(""),
      patch: value,
      patchIsPartial,
    }
  } catch {
    return { before: "", after: "", patch: value, patchIsPartial: false }
  }
}

function patchFromContent(file: string, before: string, after: string): PatchData {
  const index = contentPatchCache.findIndex(
    (entry) => entry.file === file && entry.before === before && entry.after === after,
  )
  if (index !== -1) {
    const entry = contentPatchCache[index]!
    contentPatchCache.splice(index, 1)
    contentPatchCache.push(entry)
    return entry.value
  }

  const value = {
    before,
    after,
    patch: formatPatch(
      structuredPatch(
        file,
        file,
        before,
        after,
        "",
        "",
        { context: Number.MAX_SAFE_INTEGER },
      ),
    ),
    patchIsPartial: false,
  }

  contentPatchCache.push({ file, before, after, value })
  while (contentPatchCache.length > diffCacheLimit) contentPatchCache.shift()
  return value
}

function fileDiff(file: string, patch: string, before: string, after: string, partial = false) {
  const hit = mapCache(fileDiffCache, patch)
  if (hit) return hit

  let value: FileDiffMetadata | undefined
  if (partial) value = parsePatchFiles(patch)[0]?.files[0]
  if (value === undefined) value = parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })

  return setMapCache(fileDiffCache, patch, value)
}

export function resolveFileDiff(diff: DiffSource) {
  const next = patch(diff)
  return fileDiff(diff.file, next.patch, next.before, next.after, next.patchIsPartial)
}

export function normalize(diff: ReviewDiff): ViewDiff {
  const next = patch(diff)
  return {
    file: diff.file,
    patch: next.patch,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff: fileDiff(diff.file, next.patch, next.before, next.after, next.patchIsPartial),
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}
