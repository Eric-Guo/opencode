import type { ExperimentalMigrationV1StatusOutput } from "@opencode/client/promise"
import { createEffect, onCleanup } from "solid-js"
import {
  createMigrationState,
  transitionMigration,
  type MigrationEffect,
  type MigrationEvent,
} from "./migration-status-machine"

export function createMigrationStatusPoller(input: {
  connected: () => boolean
  status: (signal: AbortSignal) => Promise<ExperimentalMigrationV1StatusOutput>
  onStatus: (status: ExperimentalMigrationV1StatusOutput) => void
  onError: (cause: unknown) => void
  onCleanup: () => void
}) {
  createEffect(() => {
    if (!input.connected()) return
    const initial = createMigrationState()
    let state = initial.state
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined

    const run = (effect: MigrationEffect) => {
      if (effect.type === "start-wait") {
        clearTimeout(timer)
        timer = setTimeout(() => dispatch({ type: "poll.due", attempt: effect.attempt }), effect.delayMs)

        return
      }

      if (effect.type === "start-poll") {
        controller?.abort()
        const current = new AbortController()
        controller = current
        clearTimeout(timer)
        timer = setTimeout(() => dispatch({ type: "poll.timed-out", attempt: effect.attempt }), effect.timeoutMs)
        void input.status(current.signal).then(
          (output) => dispatch({ type: "poll.succeeded", attempt: effect.attempt, output }),
          () => dispatch({ type: "poll.failed", attempt: effect.attempt }),
        )

        return
      }

      if (effect.type === "cancel-timer") {
        clearTimeout(timer)
        timer = undefined

        return
      }

      if (effect.type === "abort-poll") {
        controller?.abort()
        controller = undefined

        return
      }

      input.onError(new Error(effect.error))
    }

    const dispatch = (event: MigrationEvent) => {
      const next = transitionMigration(state, event)

      if (next.state === state) return
      state = next.state

      if (event.type === "poll.succeeded") input.onStatus(event.output)
      next.effects.forEach(run)
    }

    onCleanup(() => {
      dispatch({ type: "disposed" })
      input.onCleanup()
    })
    initial.effects.forEach(run)
  })
}
