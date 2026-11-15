import type { ExecutionSnapshot } from "@cybros/agent"

/** Active Runs can need a decision while their execution state remains running. */
export function executionSnapshot(snapshot: ExecutionSnapshot | null) {
  return (
    snapshot && {
      ...snapshot,
      needs_attention: !snapshot.terminal && (snapshot.needs_attention || snapshot.attention !== null),
    }
  )
}
