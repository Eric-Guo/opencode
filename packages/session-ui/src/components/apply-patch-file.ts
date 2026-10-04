import type { FileDiffInfo } from "@opencode/client/promise"
import { Match, Schema } from "effect"
import { completePatchContents, normalize, type ViewDiff } from "./session-diff"

type Kind = "add" | "update" | "delete"

export type ApplyPatchFile = {
  path: string
  type: Kind
  additions: number
  deletions: number
  view: ViewDiff
  contents?: { before: string; after: string }
}

export type ApplyPatchFileGroup = Omit<ApplyPatchFile, "view" | "contents"> & { views: ViewDiff[] }

const fileDiff = Schema.is(
  Schema.Struct({
    file: Schema.String,
    patch: Schema.String,
    additions: Schema.Number,
    deletions: Schema.Number,
    status: Schema.Literals(["added", "deleted", "modified"]),
  }),
)

export function changedFileDiff(value: Schema.Json | undefined): value is FileDiffInfo {
  return fileDiff(value) && (value.additions > 0 || value.deletions > 0)
}

export function patchFile(value: Schema.Json): ApplyPatchFile | undefined {
  if (!changedFileDiff(value)) return
  let view: ViewDiff | undefined

  return {
    path: value.file,
    type: Match.value(value.status).pipe(
      Match.when("added", () => "add" as const),
      Match.when("deleted", () => "delete" as const),
      Match.orElse(() => "update" as const),
    ),
    additions: value.additions,
    deletions: value.deletions,
    get view() {
      return (view ??= normalize(value))
    },
    contents: completePatchContents(value.patch),
  }
}

export function patchFiles(value: Schema.Json | undefined) {
  if (!Array.isArray(value)) return []

  return value.map(patchFile).filter((file): file is ApplyPatchFile => !!file)
}

export function patchFileGroups(value: Schema.Json | undefined): ApplyPatchFileGroup[] {
  const groups = patchFiles(value).reduce((result, file) => {
    const files = result.get(file.path)

    if (files) files.push(file)

    if (!files) result.set(file.path, [file])

    return result
  }, new Map<string, ApplyPatchFile[]>())

  return [...groups].map(([path, files]) => {
    const first = files[0]!
    const last = files.at(-1)!
    const type = last.type === "delete" ? "delete" : first.type === "add" ? "add" : "update"

    const chained = files.every(
      (file, index) => !!file.contents && (index === 0 || files[index - 1]?.contents?.after === file.contents.before),
    )

    if (!chained) {
      return {
        path,
        type,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        views: files.map((file) => file.view),
      }
    }

    const view =
      files.length === 1
        ? first.view
        : normalize({
            file: path,
            before: first.contents!.before,
            after: last.contents!.after,
            status: Match.value(type).pipe(
              Match.when("add", () => "added" as const),
              Match.when("delete", () => "deleted" as const),
              Match.orElse(() => "modified" as const),
            ),
            additions: 0,
            deletions: 0,
          })

    // Parsed hunks already contain net change counts, excluding unchanged context.
    const counts = view.fileDiff.hunks.reduce(
      (result, hunk) => ({
        additions: result.additions + hunk.additionLines,
        deletions: result.deletions + hunk.deletionLines,
      }),
      { additions: 0, deletions: 0 },
    )

    return {
      path,
      type,
      ...counts,
      views: [{ ...view, ...counts }],
    }
  })
}
