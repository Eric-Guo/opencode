// Thin bridge between the session-data reducer output and the footer API.
//
// The reducer produces StreamCommit[] and an optional FooterOutput (patch +
// view change). This module forwards them to footer.append() and
// footer.event() respectively, adding trace writes along the way. It also
// defaults status updates to phase "running" if the caller didn't set a
// phase -- a convenience so reducer code doesn't have to repeat that.
import type { FooterApi, FooterPatch } from "./types"
import type { SessionDataOutput } from "./session-data"

type Trace = {
  write(type: string, data?: unknown): void
}

type OutputInput = {
  footer: FooterApi
  trace?: Trace
}

// Default to "running" phase when a status string arrives without an explicit phase.
function patch(next: FooterPatch): FooterPatch {
  if (typeof next.status === "string" && next.phase === undefined) {
    return {
      phase: "running",
      ...next,
    }
  }

  return next
}

// Forwards reducer output to the footer: commits go to scrollback, patches update the status bar.
export function writeSessionOutput(input: OutputInput, out: SessionDataOutput): void {
  for (const commit of out.commits) {
    input.trace?.write("ui.commit", commit)
    input.footer.append(commit)
  }

  if (out.footer?.patch) {
    const next = patch(out.footer.patch)
    input.trace?.write("ui.patch", next)
    input.footer.event({
      type: "stream.patch",
      patch: next,
    })
  }

  if (!out.footer?.view) {
    return
  }

  input.trace?.write("ui.patch", {
    view: out.footer.view,
  })
  input.footer.event({
    type: "stream.view",
    view: out.footer.view,
  })
}
