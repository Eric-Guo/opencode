/** @jsxImportSource @opentui/solid */

import { createScrollbackWriter } from "@opentui/solid"
import { TextRenderable, type ScrollbackWriter } from "@opentui/core"
import { entryBody, entryFlags } from "./entry.body"
import { entryColor, entryLook, entrySyntax } from "./scrollback.shared"
import { toolDiffView, toolFiletype, toolStructuredFinal } from "./tool"
import { RUN_THEME_FALLBACK, type RunTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

function todoText(item: { status: string; content: string }): string {
  if (item.status === "completed") {
    return `[x] ${item.content}`
  }

  if (item.status === "cancelled") {
    return `[ ] ${item.content} (cancelled)`
  }

  if (item.status === "in_progress") {
    return `[ ] ${item.content} (in progress)`
  }

  return `[ ] ${item.content}`
}

export function entryGroupKey(commit: StreamCommit): string | undefined {
  if (!commit.partID) {
    return
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
  if (current && next && current === next) {
    return true
  }

  return left.kind === "tool" && left.phase === "start" && right.kind === "tool" && right.phase === "start"
}

export function RunEntryContent(props: {
  commit: StreamCommit
  theme?: RunTheme
  opts?: ScrollbackOptions
  width?: number
}) {
  const theme = props.theme ?? RUN_THEME_FALLBACK
  const body = entryBody(props.commit)
  if (body.type === "none") {
    return null
  }

  if (body.type === "text") {
    const style = entryLook(props.commit, theme.entry)
    return (
      <text width="100%" wrapMode="word" fg={style.fg} attributes={style.attrs}>
        {body.content}
      </text>
    )
  }

  if (body.type === "code") {
    return (
      <code
        width="100%"
        wrapMode="word"
        filetype={body.filetype}
        drawUnstyledText={false}
        streaming={props.commit.phase === "progress"}
        syntaxStyle={entrySyntax(props.commit, theme)}
        content={body.content}
        fg={entryColor(props.commit, theme)}
      />
    )
  }

  if (body.type === "structured") {
    const width = Math.max(1, Math.trunc(props.width ?? 80))

    if (body.snapshot.kind === "code") {
      return (
        <box width="100%" flexDirection="column" gap={1}>
          <text width="100%" wrapMode="word" fg={theme.block.muted}>
            {body.snapshot.title}
          </text>
          <box width="100%" paddingLeft={1}>
            <line_number width="100%" fg={theme.block.muted} minWidth={3} paddingRight={1}>
                <code
                  width="100%"
                  wrapMode="char"
                  filetype={toolFiletype(body.snapshot.file)}
                  streaming={false}
                  syntaxStyle={entrySyntax(props.commit, theme)}
                  content={body.snapshot.content}
                  fg={theme.block.text}
                />
            </line_number>
          </box>
        </box>
      )
    }

    if (body.snapshot.kind === "diff") {
      const view = toolDiffView(width, props.opts?.diffStyle)
      return (
        <box width="100%" flexDirection="column" gap={1}>
          {body.snapshot.items.map((item) => (
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

    if (body.snapshot.kind === "task") {
      return (
        <box width="100%" flexDirection="column" gap={1}>
          <text width="100%" wrapMode="word" fg={theme.block.muted}>
            {body.snapshot.title}
          </text>
          <box width="100%" flexDirection="column" gap={0} paddingLeft={1}>
            {body.snapshot.rows.map((row) => (
              <text width="100%" wrapMode="word" fg={theme.block.text}>
                {row}
              </text>
            ))}
            {body.snapshot.tail ? (
              <text width="100%" wrapMode="word" fg={theme.block.muted}>
                {body.snapshot.tail}
              </text>
            ) : null}
          </box>
        </box>
      )
    }

    if (body.snapshot.kind === "todo") {
      return (
        <box width="100%" flexDirection="column" gap={1}>
          <text width="100%" wrapMode="word" fg={theme.block.muted}>
            # Todos
          </text>
          <box width="100%" flexDirection="column" gap={0} paddingLeft={1}>
            {body.snapshot.items.map((item) => (
              <text width="100%" wrapMode="word" fg={theme.block.text}>
                {todoText(item)}
              </text>
            ))}
            {body.snapshot.tail ? (
              <text width="100%" wrapMode="word" fg={theme.block.muted}>
                {body.snapshot.tail}
              </text>
            ) : null}
          </box>
        </box>
      )
    }

    return (
      <box width="100%" flexDirection="column" gap={1}>
        <text width="100%" wrapMode="word" fg={theme.block.muted}>
          # Questions
        </text>
        <box width="100%" flexDirection="column" gap={1} paddingLeft={1}>
          {body.snapshot.items.map((item) => (
            <box width="100%" flexDirection="column" gap={0}>
              <text width="100%" wrapMode="word" fg={theme.block.muted}>
                {item.question}
              </text>
              <text width="100%" wrapMode="word" fg={theme.block.text}>
                {item.answer}
              </text>
            </box>
          ))}
          {body.snapshot.tail ? (
            <text width="100%" wrapMode="word" fg={theme.block.muted}>
              {body.snapshot.tail}
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
      content={body.content}
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
    // @ts-expect-error @opentui/solid scrollback helper still exposes solid-js JSX types
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
