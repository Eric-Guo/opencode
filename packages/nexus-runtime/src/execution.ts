import type { ExecutionSnapshot, Run } from "@cybros/agent"

/** Active Runs can need a decision while their execution state remains running. */
export function executionSnapshot(snapshot: ExecutionSnapshot | null) {
  return (
    snapshot && {
      ...snapshot,
      needs_attention: !snapshot.terminal && (snapshot.needs_attention || snapshot.attention !== null),
    }
  )
}

export function repairableTasks(run: Run) {
  return run.tasks.filter(
    (task) =>
      ["failed", "timed_out", "uncertain"].includes(task.status) &&
      !task.failure_resolution &&
      (task.on_failure !== "absorb" ||
        (task.kind === "model_task" && task.error?.key === "conversation_cost_limit_reached")),
  )
}

export function repairTaskKey(run: Run) {
  const candidates = repairableTasks(run)

  if (!candidates.length) throw new Error("No task on this run has an unresolved failure.")
  if (candidates.length > 1) throw new Error("Name one of: " + candidates.map((task) => task.key).join(", "))

  return candidates[0].key
}
