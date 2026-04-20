/** @jsxImportSource @opentui/solid */

import { createScrollbackWriter } from "@opentui/solid"
import { TextRenderable, type ScrollbackWriter } from "@opentui/core"
import { createMemo } from "solid-js"
import { entryBody, entryFlags } from "./entry.body"
import { entryColor, entryLook, entrySyntax } from "./scrollback.shared"
import { toolDiffView, toolFiletype, toolStructuredFinal } from "./tool"
import { RUN_THEME_FALLBACK, type RunTheme } from "./theme"
import type { EntryLayout, RunEntryBody, ScrollbackOptions, StreamCommit } from "./types"

function todoText(item: { status: string; content: string }): string {
  if (item.status === "completed") {
    return `[✓] ${item.content}`
  }

  if (item.status === "cancelled") {
    return `~[ ] ${item.content}~`
  }

  if (item.status === "in_progress") {
    return `[•] ${item.content}`
  }

  return `[ ] ${item.content}`
}

function todoColor(theme: RunTheme, status: string) {
  return status === "in_progress" ? theme.footer.warning : theme.block.muted
}

export function entryGroupKey(commit: StreamCommit): string | undefined {
  if (!commit.partID) {
    return undefined
  }

  if (toolStructuredFinal(commit)) {
    return `tool:${commit.partID}:final`
  }

  return `${commit.kind}:${commit.partID}`
}

export function sameEntryGroup(left: StreamCommit | undefined, right: StreamCommit): boolean {
  if (!left) {
    return false
  }

  const current = entryGroupKey(left)
  const next = entryGroupKey(right)
  return Boolean(current && next && current === next)
}

export function entryLayout(commit: StreamCommit, body: RunEntryBody = entryBody(commit)): EntryLayout {
  if (commit.kind === "tool") {
    if (body.type === "structured" || body.type === "markdown") {
      return "block"
    }

    return "inline"
  }

  if (commit.kind === "reasoning") {
    return "block"
  }

  return "block"
}

export function separatorRows(
  prev: StreamCommit | undefined,
  next: StreamCommit,
  body: RunEntryBody = entryBody(next),
): number {
  if (!prev || sameEntryGroup(prev, next)) {
    return 0
  }

  if (entryLayout(prev) === "inline" && entryLayout(next, body) === "inline") {
    return 0
  }

  return 1
}

export function RunEntryContent(props: {
  commit: StreamCommit
  theme?: RunTheme
  opts?: ScrollbackOptions
  width?: number
}) {
  const theme = props.theme ?? RUN_THEME_FALLBACK
  const body = createMemo(() => entryBody(props.commit))
  const text = () => {
    const value = body()
    return value.type === "text" ? value : undefined
  }
  const code = () => {
    const value = body()
    return value.type === "code" ? value : undefined
  }
  const snapshot = () => {
    const value = body()
    return value.type === "structured" ? value.snapshot : undefined
  }
  const markdown = () => {
    const value = body()
    return value.type === "markdown" ? value : undefined
  }

  if (body().type === "none") {
    return null
  }

  if (body().type === "text") {
    const style = entryLook(props.commit, theme.entry)
    return (
      <text width="100%" wrapMode="word" fg={style.fg} attributes={style.attrs}>
        {text()?.content}
      </text>
    )
  }

  if (body().type === "code") {
    return (
      <code
        width="100%"
        wrapMode="word"
        filetype={code()?.filetype}
        drawUnstyledText={false}
        streaming={props.commit.phase === "progress"}
        syntaxStyle={entrySyntax(props.commit, theme)}
        content={code()?.content}
        fg={entryColor(props.commit, theme)}
      />
    )
  }

  if (body().type === "structured") {
    const snap = snapshot()
    if (!snap) {
      return null
    }

    const width = Math.max(1, Math.trunc(props.width ?? 80))

    if (snap.kind === "code") {
      return (
        <box width="100%" flexDirection="column" gap={1}>
          <text width="100%" wrapMode="word" fg={theme.block.muted}>
            {snap.title}
          </text>
          <box width="100%" paddingLeft={1}>
            <line_number width="100%" fg={theme.block.muted} minWidth={3} paddingRight={1}>
              <code
                width="100%"
                wrapMode="char"
                filetype={toolFiletype(snap.file)}
                streaming={false}
                syntaxStyle={entrySyntax(props.commit, theme)}
                content={snap.content}
                fg={theme.block.text}
              />
            </line_number>
          </box>
        </box>
      )
    }

    if (snap.kind === "diff") {
      const view = toolDiffView(width, props.opts?.diffStyle)
      return (
        <box width="100%" flexDirection="column" gap={1}>
          {snap.items.map((item) => (
            <box width="100%" flexDirection="column" gap={1}>
              <text width="100%" wrapMode="word" fg={theme.block.muted}>
                {item.title}
              </text>
              {item.diff.trim() ? (
                <box width="100%" paddingLeft={1}>
                  <diff
                    diff={item.diff}
                    view={view}
                    filetype={toolFiletype(item.file)}
                    syntaxStyle={entrySyntax(props.commit, theme)}
                    showLineNumbers={true}
                    width="100%"
                    wrapMode="word"
                    fg={theme.block.text}
                    addedBg={theme.block.diffAddedBg}
                    removedBg={theme.block.diffRemovedBg}
                    contextBg={theme.block.diffContextBg}
                    addedSignColor={theme.block.diffHighlightAdded}
                    removedSignColor={theme.block.diffHighlightRemoved}
                    lineNumberFg={theme.block.diffLineNumber}
                    lineNumberBg={theme.block.diffContextBg}
                    addedLineNumberBg={theme.block.diffAddedLineNumberBg}
                    removedLineNumberBg={theme.block.diffRemovedLineNumberBg}
                  />
                </box>
              ) : (
                <text width="100%" wrapMode="word" fg={theme.block.diffRemoved}>
                  -{item.deletions ?? 0} line{item.deletions === 1 ? "" : "s"}
                </text>
              )}
            </box>
          ))}
        </box>
      )
    }

    if (snap.kind === "task") {
      return (
        <box width="100%" flexDirection="column" gap={1}>
          <text width="100%" wrapMode="word" fg={theme.block.muted}>
            {snap.title}
          </text>
          <box width="100%" flexDirection="column" gap={0} paddingLeft={1}>
            {snap.rows.map((row) => (
              <text width="100%" wrapMode="word" fg={theme.block.text}>
                {row}
              </text>
            ))}
            {snap.tail ? (
              <text width="100%" wrapMode="word" fg={theme.block.muted}>
                {snap.tail}
              </text>
            ) : null}
          </box>
        </box>
      )
    }

    if (snap.kind === "todo") {
      return (
        <box width="100%" flexDirection="column" gap={1}>
          <text width="100%" wrapMode="word" fg={theme.block.muted}>
            # Todos
          </text>
          <box width="100%" flexDirection="column" gap={0}>
            {snap.items.map((item) => (
              <text width="100%" wrapMode="word" fg={todoColor(theme, item.status)}>
                {todoText(item)}
              </text>
            ))}
            {snap.tail ? (
              <text width="100%" wrapMode="word" fg={theme.block.muted}>
                {snap.tail}
              </text>
            ) : null}
          </box>
        </box>
      )
    }

    if (snap.kind !== "question") {
      return null
    }

    return (
      <box width="100%" flexDirection="column" gap={1}>
        <text width="100%" wrapMode="word" fg={theme.block.muted}>
          # Questions
        </text>
          <box width="100%" flexDirection="column" gap={1}>
            {snap.items.map((item) => (
              <box width="100%" flexDirection="column" gap={0}>
              <text width="100%" wrapMode="word" fg={theme.block.muted}>
                {item.question}
              </text>
              <text width="100%" wrapMode="word" fg={theme.block.text}>
                {item.answer}
              </text>
            </box>
          ))}
          {snap.tail ? (
            <text width="100%" wrapMode="word" fg={theme.block.muted}>
              {snap.tail}
            </text>
          ) : null}
        </box>
      </box>
    )
  }

  return (
    <markdown
      width="100%"
      syntaxStyle={entrySyntax(props.commit, theme)}
      streaming={props.commit.phase === "progress"}
      content={markdown()?.content}
      fg={entryColor(props.commit, theme)}
      tableOptions={{ widthMode: "content" }}
    />
  )
}

export function entryWriter(input: {
  commit: StreamCommit
  theme?: RunTheme
  opts?: ScrollbackOptions
}): ScrollbackWriter {
  return createScrollbackWriter(
    (ctx) => <RunEntryContent commit={input.commit} theme={input.theme} opts={input.opts} width={ctx.width} />,
    entryFlags(input.commit),
  )
}

export function spacerWriter(): ScrollbackWriter {
  return (ctx) => ({
    root: new TextRenderable(ctx.renderContext, {
      id: "run-scrollback-spacer",
      width: Math.max(1, Math.trunc(ctx.width)),
      height: 1,
      content: "",
    }),
    width: Math.max(1, Math.trunc(ctx.width)),
    height: 1,
    startOnNewLine: true,
    trailingNewline: true,
  })
}
