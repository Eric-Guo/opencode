import type { Client, Run, RunnerEffects } from "@cybros/agent"
import { FileDiff } from "@opencode/schema/file-diff"
import { Option, Schema } from "effect"

export { publishedArtifacts } from "./published-artifacts"

const Change = Schema.Struct({ root: Schema.String, change: FileDiff.Info })
const Tree = Schema.Struct({ root: Schema.String, changes: Schema.Array(FileDiff.Info), truncated: Schema.Boolean })

export const RestoreCheckpoint = Schema.Struct({ hash: Schema.NonEmptyString, store: Schema.String })
export const checkpointTools: ReadonlySet<string> = new Set(["write", "edit", "bash"])

const Snapshot = Schema.Struct({
  root: Schema.String,
  base: Schema.NonEmptyString,
  captured_at: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
  truncated: Schema.Boolean,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      state: Schema.Literals(["text", "binary", "too_large", "omitted", "unavailable"]),
      status: Schema.Literals(["A", "D", "M", "T"]),
      patch: Schema.optionalKey(Schema.String),
      additions: Schema.optionalKey(FileDiff.Info.fields.additions),
      deletions: Schema.optionalKey(FileDiff.Info.fields.deletions),
    }),
  ),
})

export type Review = {
  source?: "checkpoint"
  runner: string
  root: string
  base: string
  run: string
  truncated: boolean
  restoreTasks: string[]
  files: {
    path: string
    state: string
    patch?: string
    additions?: number
    deletions?: number
    status: "added" | "deleted" | "modified"
  }[]
}

const status = { A: "added", D: "deleted", M: "modified", T: "modified" } as const

/** Read retained results as of the answer, even after its runners have moved or gone offline. */
export async function recordedChanges(
  run: ReturnType<ReturnType<Client["workspace"]>["run"]>,
  data: Run,
  effects: RunnerEffects,
  localRunner: string | null,
): Promise<Review[]> {
  const runners = new Set(effects.runners.map((row) => row.runner_executor_public_id))
  const cutoff = data.tasks.find((task) => task.key === data.deliverable_task_key)?.completed_at ?? data.completed_at
  const snapshots = new Map<string, { runner: string; snapshot: typeof Snapshot.Type }>()
  const steps = new Map<string, Review[]>()

  for (const task of data.tasks) {
    const runner = task.target?.executor_public_id
    if (!runner || !runners.has(runner) || task.target?.kind === "mcp" || task.status !== "completed") continue
    if (cutoff && task.completed_at && compareTime(task.completed_at, cutoff) > 0) continue

    const detail = await run.task(task.key).fetch()
    const capture = Schema.decodeUnknownOption(Snapshot)(detail.metadata?.["rho.changes"])
    if (capture._tag === "Some") {
      const snapshot = capture.value
      const key = JSON.stringify([runner, snapshot.root])
      const previous = snapshots.get(key)
      if (!previous || compareTime(snapshot.captured_at, previous.snapshot.captured_at) > 0)
        snapshots.set(key, { runner, snapshot })
    }

    if (!checkpointTools.has(task.tool_name ?? "")) continue
    const change = Schema.decodeUnknownOption(Change)(detail.structured_content)
    const tree =
      change._tag === "Some"
        ? { root: change.value.root, changes: [change.value.change], truncated: false }
        : Option.getOrUndefined(Schema.decodeUnknownOption(Tree)(detail.structured_content))
    if (!tree?.changes.length) continue

    const key = JSON.stringify([runner, tree.root])
    const group = steps.get(key) ?? []
    group.push({
      runner,
      root: tree.root,
      base: task.key,
      run: data.public_id,
      truncated: tree.truncated,
      restoreTasks:
        runner === localRunner && Schema.is(RestoreCheckpoint)(detail.metadata?.checkpoint) ? [task.key] : [],
      files: tree.changes.map((file) => ({
        state: "text",
        path: file.file,
        status: file.status,
        patch: file.patch,
        additions: file.additions,
        deletions: file.deletions,
      })),
    })
    steps.set(key, group)
  }

  const reviews: Review[] = []
  for (const [key, { runner, snapshot }] of snapshots) {
    const local = steps.get(key) ?? []
    steps.delete(key)
    if (!snapshot.files.length && !snapshot.truncated) continue
    reviews.push({
      source: "checkpoint",
      runner,
      run: data.public_id,
      base: snapshot.base,
      root: snapshot.root,
      truncated: snapshot.truncated,
      restoreTasks: local.flatMap((step) => step.restoreTasks),
      files: snapshot.files.map((file) => ({ ...file, status: status[file.status] })),
    })
  }
  // Older OpenCode results can carry a per-task patch without a cumulative capture.
  return [...reviews, ...Array.from(steps.values()).flat()]
}

function compareTime(a: string, b: string) {
  // Date.parse handles timezone offsets, but drops the sub-millisecond part of Nexus timestamps.
  return (
    Date.parse(a) - Date.parse(b) ||
    Number("0." + (/\.(\d+)/.exec(a)?.[1] ?? "0")) - Number("0." + (/\.(\d+)/.exec(b)?.[1] ?? "0"))
  )
}
