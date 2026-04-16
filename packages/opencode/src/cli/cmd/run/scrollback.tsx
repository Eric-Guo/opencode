// Entry writer routing for scrollback commits.
//
// Decides whether a commit should render as plain text or as a rich snapshot
// (code block, diff view, task card, etc.). Completed tool parts whose tool
// rule has a "snap" mode get routed to snapEntryWriter, which produces a
// structured JSX snapshot. Everything else goes through textEntryWriter.
import type { ScrollbackWriter } from "@opentui/core"
import { toolView } from "./tool"
import { snapEntryWriter, textEntryWriter } from "./scrollback.writer"
import { RUN_THEME_FALLBACK, type RunTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

export function entryWriter(
  commit: StreamCommit,
  theme: RunTheme = RUN_THEME_FALLBACK,
  opts: ScrollbackOptions = {},
): ScrollbackWriter {
  const state = commit.toolState ?? commit.part?.state.status
  if (commit.kind === "tool" && commit.phase === "final" && state === "completed") {
    if (toolView(commit.tool).snap) {
      return snapEntryWriter(commit, theme, opts)
    }
  }

  return textEntryWriter(commit, theme.entry)
}
