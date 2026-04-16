// Text normalization for scrollback entries.
//
// Transforms a StreamCommit into the final text that will be appended to
// terminal scrollback. Each entry kind has its own formatting:
//
//   user       → prefixed with "› "
//   assistant  → raw text (progress), empty (start/final unless interrupted)
//   reasoning  → raw text with [REDACTED] stripped
//   tool       → delegated to tool.ts for per-tool scrollback formatting
//   error/system → raw trimmed text
//
// Returns an empty string when the commit should produce no visible output
// (e.g., assistant start events, empty final events).
import { toolFrame, toolScroll, toolView } from "./tool"
import type { StreamCommit } from "./types"

export function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function toolText(commit: StreamCommit, raw: string): string {
  const ctx = toolFrame(commit, raw)
  const view = toolView(ctx.name)

  if (commit.phase === "progress" && !view.output) {
    return ""
  }

  if (commit.phase === "final") {
    if (ctx.status === "error") {
      return toolScroll("final", ctx)
    }

    if (!view.final) {
      return ""
    }

    if (ctx.status && ctx.status !== "completed") {
      return ctx.raw.trim()
    }
  }

  return toolScroll(commit.phase, ctx)
}

export function normalizeEntry(commit: StreamCommit): string {
  const raw = clean(commit.text)

  if (commit.kind === "user") {
    if (!raw.trim()) {
      return ""
    }

    const lead = raw.match(/^\n+/)?.[0] ?? ""
    const body = lead ? raw.slice(lead.length) : raw
    return `${lead}› ${body}`
  }

  if (commit.kind === "tool") {
    return toolText(commit, raw)
  }

  if (commit.kind === "assistant") {
    if (commit.phase === "start") {
      return ""
    }

    if (commit.phase === "final") {
      return commit.interrupted ? "assistant interrupted" : ""
    }

    return raw
  }

  if (commit.kind === "reasoning") {
    if (commit.phase === "start") {
      return ""
    }

    if (commit.phase === "final") {
      return commit.interrupted ? "reasoning interrupted" : ""
    }

    return raw.replace(/\[REDACTED\]/g, "")
  }

  if (commit.phase === "start" || commit.phase === "final") {
    return raw.trim()
  }

  return raw
}
