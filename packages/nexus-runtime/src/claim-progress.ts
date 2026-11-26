import { setTimeout } from "node:timers/promises"
import { transientControlError } from "./claim-control"

/** Nexus drops faster frames with 202; keep the latest tail until its 250 ms cadence admits it. */
export function claimProgress(post: (text: string) => Promise<void>, signal: AbortSignal) {
  const state = { tail: "", posted: "", next: 0, stopped: false, work: undefined as Promise<void> | undefined }
  const flush = async () => {
    while (!signal.aborted && !state.stopped && state.tail && state.tail !== state.posted) {
      const wait = state.next - Date.now()
      if (wait > 0) await setTimeout(wait, undefined, { signal }).catch(() => {})
      if (signal.aborted) return
      const text = state.tail
      await post(text).then(
        () => {
          state.posted = text
        },
        (error: unknown) => {
          // A transient refusal costs this frame; the cadence retries the tail. A typed refusal ends the posting.
          if (!transientControlError(error)) state.stopped = true
        },
      )
      state.next = Date.now() + 250
    }
  }
  const write = (text: string): Promise<void> => {
    if (signal.aborted || state.stopped || !text) return Promise.resolve()
    state.tail = text
    return (state.work ??= flush().finally(() => {
      state.work = undefined
      if (state.tail !== state.posted && !state.stopped && !signal.aborted) return write(state.tail)
    }))
  }
  return write
}
