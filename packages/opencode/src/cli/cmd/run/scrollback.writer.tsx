/** @jsxImportSource @opentui/solid */

import { createScrollbackWriter } from "@opentui/solid"
import { TextRenderable, type ScrollbackWriter } from "@opentui/core"
import { Match, Switch, createMemo } from "solid-js"
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
  const theme = createMemo(() => props.theme ?? RUN_THEME_FALLBACK)
  const body = createMemo(() => entryBody(props.commit))
  const style = createMemo(() => entryLook(props.commit, theme().entry))
  const syntax = createMemo(() => entrySyntax(props.commit, theme()))
  const color = createMemo(() => entryColor(props.commit, theme()))
  const streaming = createMemo(() => props.commit.phase === "progress")
  const width = createMemo(() => Math.max(1, Math.trunc(props.width ?? 80)))
  const view = createMemo(() => toolDiffView(width(), props.opts?.diffStyle))
  const text = createMemo(() => {
    const next = body()
    return next.type === "text" ? next : undefined
  })
  const code = createMemo(() => {
    const next = body()
    return next.type === "code" ? next : undefined
  })
  const structured = createMemo(() => {
    const next = body()
    return next.type === "structured" ? next.snapshot : undefined
  })
  const markdown = createMemo(() => {
    const next = body()
    return next.type === "markdown" ? next : undefined
  })
  const code_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "code" ? next : undefined
  })
  const diff_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "diff" ? next : undefined
  })
  const task_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "task" ? next : undefined
  })
  const todo_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "todo" ? next : undefined
  })
  const question_snapshot = createMemo(() => {
    const next = structured()
    return next?.kind === "question" ? next : undefined
  })

  return (
    <Switch fallback={null}>
      <Match when={text()}>
        {(body) => (
          <text width="100%" wrapMode="word" fg={style().fg} attributes={style().attrs}>
            {body().content}
          </text>
        )}
      </Match>
      <Match when={code()}>
        {(body) => (
          <code
            width="100%"
            wrapMode="word"
            filetype={body().filetype}
            drawUnstyledText={false}
            streaming={streaming()}
            syntaxStyle={syntax()}
            content={body().content}
            fg={color()}
          />
        )}
      </Match>
      <Match when={code_snapshot()}>
        {(snap) => (
          <box width="100%" flexDirection="column" gap={1}>
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              {snap().title}
            </text>
            <box width="100%" paddingLeft={1}>
              <line_number width="100%" fg={theme().block.muted} minWidth={3} paddingRight={1}>
                <code
                  width="100%"
                  wrapMode="char"
                  filetype={toolFiletype(snap().file)}
                  streaming={false}
                  syntaxStyle={syntax()}
                  content={snap().content}
                  fg={theme().block.text}
                />
              </line_number>
            </box>
          </box>
        )}
      </Match>
      <Match when={diff_snapshot()}>
        {(snap) => (
          <box width="100%" flexDirection="column" gap={1}>
            {snap().items.map((item) => (
              <box width="100%" flexDirection="column" gap={1}>
                <text width="100%" wrapMode="word" fg={theme().block.muted}>
                  {item.title}
                </text>
                {item.diff.trim() ? (
                  <box width="100%" paddingLeft={1}>
                    <diff
                      diff={item.diff}
                      view={view()}
                      filetype={toolFiletype(item.file)}
                      syntaxStyle={syntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode="word"
                      fg={theme().block.text}
                      addedBg={theme().block.diffAddedBg}
                      removedBg={theme().block.diffRemovedBg}
                      contextBg={theme().block.diffContextBg}
                      addedSignColor={theme().block.diffHighlightAdded}
                      removedSignColor={theme().block.diffHighlightRemoved}
                      lineNumberFg={theme().block.diffLineNumber}
                      lineNumberBg={theme().block.diffContextBg}
                      addedLineNumberBg={theme().block.diffAddedLineNumberBg}
                      removedLineNumberBg={theme().block.diffRemovedLineNumberBg}
                    />
                  </box>
                ) : (
                  <text width="100%" wrapMode="word" fg={theme().block.diffRemoved}>
                    -{item.deletions ?? 0} line{item.deletions === 1 ? "" : "s"}
                  </text>
                )}
              </box>
            ))}
          </box>
        )}
      </Match>
      <Match when={task_snapshot()}>
        {(snap) => (
          <box width="100%" flexDirection="column" gap={1}>
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              {snap().title}
            </text>
            <box width="100%" flexDirection="column" gap={0} paddingLeft={1}>
              {snap().rows.map((row) => (
                <text width="100%" wrapMode="word" fg={theme().block.text}>
                  {row}
                </text>
              ))}
              {snap().tail ? (
                <text width="100%" wrapMode="word" fg={theme().block.muted}>
                  {snap().tail}
                </text>
              ) : null}
            </box>
          </box>
        )}
      </Match>
      <Match when={todo_snapshot()}>
        {(snap) => (
          <box width="100%" flexDirection="column" gap={1}>
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              # Todos
            </text>
            <box width="100%" flexDirection="column" gap={0}>
              {snap().items.map((item) => (
                <text width="100%" wrapMode="word" fg={todoColor(theme(), item.status)}>
                  {todoText(item)}
                </text>
              ))}
              {snap().tail ? (
                <text width="100%" wrapMode="word" fg={theme().block.muted}>
                  {snap().tail}
                </text>
              ) : null}
            </box>
          </box>
        )}
      </Match>
      <Match when={question_snapshot()}>
        {(snap) => (
          <box width="100%" flexDirection="column" gap={1}>
            <text width="100%" wrapMode="word" fg={theme().block.muted}>
              # Questions
            </text>
            <box width="100%" flexDirection="column" gap={1}>
              {snap().items.map((item) => (
                <box width="100%" flexDirection="column" gap={0}>
                  <text width="100%" wrapMode="word" fg={theme().block.muted}>
                    {item.question}
                  </text>
                  <text width="100%" wrapMode="word" fg={theme().block.text}>
                    {item.answer}
                  </text>
                </box>
              ))}
              {snap().tail ? (
                <text width="100%" wrapMode="word" fg={theme().block.muted}>
                  {snap().tail}
                </text>
              ) : null}
            </box>
          </box>
        )}
      </Match>
      <Match when={markdown()}>
        {(body) => (
          <markdown
            width="100%"
            syntaxStyle={syntax()}
            streaming={streaming()}
            content={body().content}
            fg={color()}
            tableOptions={{ widthMode: "content" }}
          />
        )}
      </Match>
    </Switch>
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
