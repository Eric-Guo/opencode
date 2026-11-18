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

export function modelRecoveryHint(key: unknown) {
  if (key === "conversation_cost_limit_reached")
    return "The Conversation cost limit has been reached. Raise or clear that limit, then retry the held model task to continue from its existing graph. Changing the limit does not restart work."
  if (key === "provider_context_overflow")
    return "Context exceeds the model server's limit. In Nexus Settings > Model providers > Edit model > Context and capabilities, match Input token limit or Combined context window to the server's actual limit (use only one), and check Output token limit. If needed, lower the requested output budget, shorten the input, or start a new conversation."
}
