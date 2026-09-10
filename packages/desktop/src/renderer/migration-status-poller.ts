import type { MigrationV1StatusOutput } from "@opencode/client/promise"
import { createEffect, onCleanup } from "solid-js"

export function createMigrationStatusPoller(input: {
  connected: () => boolean
  status: (signal: AbortSignal) => Promise<MigrationV1StatusOutput>
  onStatus: (status: MigrationV1StatusOutput) => void
  onError: (error: unknown) => void
  onCleanup: () => void
}) {
  createEffect(() => {
    if (!input.connected()) return
    const abort = new AbortController()
    onCleanup(() => {
      abort.abort()
      input.onCleanup()
    })
    void (async () => {
      while (!abort.signal.aborted) {
        await wait(1_000, abort.signal)
        if (abort.signal.aborted) return
        const status = await input.status(abort.signal)
        if (abort.signal.aborted) return
        input.onStatus(status)
        if (status.status === "completed") return
        if (status.status === "error") throw new Error(status.error)
      }
    })().catch((error) => {
      if (!abort.signal.aborted) input.onError(error)
    })
  })
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
