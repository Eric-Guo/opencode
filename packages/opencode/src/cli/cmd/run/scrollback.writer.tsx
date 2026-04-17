// JSX-based scrollback snapshot writers for rich tool output.
//
// When a tool commit has a "snap" mode (code, diff, task, todo, question),
// snapEntryWriter renders it as a structured JSX tree that OpenTUI converts
// into a ScrollbackSnapshot. These snapshots support syntax highlighting,
// unified/split diffs, line numbers, and LSP diagnostics.
//
// The writers use OpenTUI's createScrollbackWriter to produce snapshots.
// OpenTUI measures and reflows them when the terminal resizes. The fit()
// helper measures actual rendered width so narrow content doesn't claim
// the full terminal width.
//
// Plain text entries (textEntryWriter) also go through here -- they just
// produce a simple <text> element with the right color and attributes.
/** @jsxImportSource @opentui/solid */

import {
  SyntaxStyle,
  TextAttributes,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { createScrollbackWriter, type JSX } from "@opentui/solid"
import { For, Show } from "solid-js"
import * as Filesystem from "../../../util/filesystem"
import { toolDiffView, toolFiletype, toolFrame, toolSnapshot, toolView } from "./tool"
import { clean, normalizeEntry } from "./scrollback.format"
import { RUN_THEME_FALLBACK, type RunEntryTheme, type RunTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

type ToolDict = Record<string, unknown>

function dict(v: unknown): ToolDict {
  if (!v || typeof v !== "object") {
    return {}
  }

  return v as ToolDict
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function num(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return
  }

  return v
}

function diagnostics(meta: ToolDict, file: string): string[] {
  const all = dict(meta.diagnostics)
  const key = Filesystem.normalizePath(file)
  const list = arr(all[key]).map(dict)
  return list
    .filter((item) => item.severity === 1)
    .slice(0, 3)
    .map((item) => {
      const range = dict(item.range)
      const start = dict(range.start)
      const line = num(start.line)
      const char = num(start.character)
      const msg = text(item.message)
      if (line === undefined || char === undefined) {
        return `Error ${msg}`.trim()
      }

      return `Error [${line + 1}:${char + 1}] ${msg}`.trim()
    })
}

type Flags = {
  startOnNewLine: boolean
  trailingNewline: boolean
}

type Paint = {
  fg: ColorInput
  attrs?: number
}

type CodeInput = {
  title: string
  content: string
  filetype?: string
  diagnostics: string[]
}

type DiffInput = {
  title: string
  diff?: string
  filetype?: string
  deletions?: number
  diagnostics: string[]
}

type TaskInput = {
  title: string
  rows: string[]
  tail: string
}

type TodoInput = {
  items: Array<{
    status: string
    content: string
  }>
  tail: string
}

type QuestionInput = {
  items: Array<{
    question: string
    answer: string
  }>
  tail: string
}

type Measure = {
  widthColsMax: number
}

type MeasureNode = {
  textBufferView?: {
    measureForDimensions(width: number, height: number): Measure | null
  }
  getChildren?: () => unknown[]
}

let bare: SyntaxStyle | undefined

function syntax(style?: SyntaxStyle): SyntaxStyle {
  if (style) {
    return style
  }

  bare ??= SyntaxStyle.fromTheme([])
  return bare
}

function failed(commit: StreamCommit): boolean {
  return commit.kind === "tool" && (commit.toolState === "error" || commit.part?.state.status === "error")
}

function look(commit: StreamCommit, theme: RunEntryTheme): Paint {
  if (commit.kind === "user") {
    return {
      fg: theme.user.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (failed(commit)) {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (commit.phase === "final") {
    return {
      fg: theme.system.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "tool" && commit.phase === "start") {
    return {
      fg: theme.tool.start ?? theme.tool.body,
    }
  }

  if (commit.kind === "assistant") {
    return { fg: theme.assistant.body }
  }

  if (commit.kind === "reasoning") {
    return {
      fg: theme.reasoning.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "error") {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (commit.kind === "tool") {
    return { fg: theme.tool.body }
  }

  return { fg: theme.system.body }
}

function cols(ctx: ScrollbackRenderContext): number {
  return Math.max(1, Math.trunc(ctx.width))
}

function leaf(node: unknown): MeasureNode | undefined {
  if (!node || typeof node !== "object") {
    return
  }

  const next = node as MeasureNode
  if (next.textBufferView) {
    return next
  }

  const list = next.getChildren?.() ?? []
  for (const child of list) {
    const out = leaf(child)
    if (out) {
      return out
    }
  }
}

function fit(snapshot: ScrollbackSnapshot, ctx: ScrollbackRenderContext) {
  const node = leaf(snapshot.root)
  const width = cols(ctx)
  const box = node?.textBufferView?.measureForDimensions(width, Math.max(1, snapshot.height ?? 1))
  const rowColumns = Math.max(1, Math.min(width, box?.widthColsMax ?? 0))

  snapshot.width = width
  snapshot.rowColumns = rowColumns
  return snapshot
}

function full(node: () => JSX.Element, ctx: ScrollbackRenderContext, flags: Flags) {
  return createScrollbackWriter(node, {
    width: cols(ctx),
    rowColumns: cols(ctx),
    startOnNewLine: flags.startOnNewLine,
    trailingNewline: flags.trailingNewline,
  })(ctx)
}

function TextEntry(props: { body: string; fg: ColorInput; attrs?: number }) {
  return (
    <text width="100%" wrapMode="word" fg={props.fg} attributes={props.attrs}>
      {props.body}
    </text>
  )
}

function thinking(body: string) {
  const mark = "Thinking: "
  if (body.startsWith(mark)) {
    return {
      head: mark,
      tail: body.slice(mark.length),
    }
  }

  return {
    tail: body,
  }
}

function ReasoningEntry(props: { body: string; theme: RunEntryTheme }) {
  const part = thinking(props.body)
  return (
    <text
      width="100%"
      wrapMode="word"
      fg={props.theme.reasoning.body}
      attributes={TextAttributes.DIM | TextAttributes.ITALIC}
    >
      <Show when={part.head}>{part.head}</Show>
      {part.tail}
    </text>
  )
}

function Diagnostics(props: { theme: RunTheme; lines: string[] }) {
  return (
    <Show when={props.lines.length > 0}>
      <box>
        <For each={props.lines}>{(line) => <text fg={props.theme.entry.error.body}>{line}</text>}</For>
      </box>
    </Show>
  )
}

function BlockTool(props: { theme: RunTheme; title: string; children: JSX.Element }) {
  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.theme.block.muted} attributes={TextAttributes.DIM}>
        {props.title}
      </text>
      {props.children}
    </box>
  )
}

function CodeTool(props: { theme: RunTheme; data: CodeInput }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <line_number fg={props.theme.block.muted} minWidth={3} paddingRight={1}>
        <code
          conceal={false}
          fg={props.theme.block.text}
          filetype={props.data.filetype}
          syntaxStyle={syntax(props.theme.block.syntax)}
          content={props.data.content}
          drawUnstyledText={true}
          wrapMode="word"
        />
      </line_number>
      <Diagnostics theme={props.theme} lines={props.data.diagnostics} />
    </BlockTool>
  )
}

function DiffTool(props: { theme: RunTheme; data: DiffInput; view: "unified" | "split" }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <Show
        when={props.data.diff?.trim()}
        fallback={
          <text fg={props.theme.block.diffRemoved}>
            -{props.data.deletions ?? 0} line{props.data.deletions === 1 ? "" : "s"}
          </text>
        }
      >
        <box>
          <diff
            diff={props.data.diff ?? ""}
            view={props.view}
            filetype={props.data.filetype}
            syntaxStyle={syntax(props.theme.block.syntax)}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={props.theme.block.text}
            addedBg={props.theme.block.diffAddedBg}
            removedBg={props.theme.block.diffRemovedBg}
            contextBg={props.theme.block.diffContextBg}
            addedSignColor={props.theme.block.diffHighlightAdded}
            removedSignColor={props.theme.block.diffHighlightRemoved}
            lineNumberFg={props.theme.block.diffLineNumber}
            lineNumberBg={props.theme.block.diffContextBg}
            addedLineNumberBg={props.theme.block.diffAddedLineNumberBg}
            removedLineNumberBg={props.theme.block.diffRemovedLineNumberBg}
          />
        </box>
      </Show>
      <Diagnostics theme={props.theme} lines={props.data.diagnostics} />
    </BlockTool>
  )
}

function TaskTool(props: { theme: RunTheme; data: TaskInput }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <box>
        <For each={props.data.rows}>{(line) => <text fg={props.theme.block.text}>{line}</text>}</For>
      </box>
      <text fg={props.theme.block.muted} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
    </BlockTool>
  )
}

function todoMark(status: string): string {
  if (status === "completed") {
    return "[x]"
  }
  if (status === "in_progress") {
    return "[>]"
  }
  if (status === "cancelled") {
    return "[-]"
  }
  return "[ ]"
}

function TodoTool(props: { theme: RunTheme; data: TodoInput }) {
  return (
    <BlockTool theme={props.theme} title="# Todos">
      <box>
        <For each={props.data.items}>
          {(item) => (
            <text fg={props.theme.block.text}>
              {todoMark(item.status)} {item.content}
            </text>
          )}
        </For>
      </box>
      <text fg={props.theme.block.muted} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
    </BlockTool>
  )
}

function QuestionTool(props: { theme: RunTheme; data: QuestionInput }) {
  return (
    <BlockTool theme={props.theme} title="# Questions">
      <text fg={props.theme.block.muted} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
      <box gap={1}>
        <For each={props.data.items}>
          {(item) => (
            <box flexDirection="column">
              <text fg={props.theme.block.muted}>{item.question}</text>
              <text fg={props.theme.block.text}>{item.answer}</text>
            </box>
          )}
        </For>
      </box>
    </BlockTool>
  )
}

function snapCommit(commit: StreamCommit) {
  const state = commit.toolState ?? commit.part?.state.status
  return (
    commit.kind === "tool" &&
    commit.phase === "final" &&
    state === "completed" &&
    Boolean(toolView(commit.tool ?? commit.part?.tool).snap)
  )
}

export function entryGroupKey(commit: StreamCommit): string | undefined {
  if (!commit.partID) {
    return
  }

  if (snapCommit(commit)) {
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

export function RunEntryTextContent(props: { commit: StreamCommit; theme: RunEntryTheme }) {
  const body = normalizeEntry(props.commit)
  if (props.commit.kind === "reasoning") {
    return <ReasoningEntry body={body} theme={props.theme} />
  }

  const style = look(props.commit, props.theme)
  return <TextEntry body={body} fg={style.fg} attrs={style.attrs} />
}

export function RunEntrySnapContent(props: {
  commit: StreamCommit
  theme: RunTheme
  opts?: ScrollbackOptions
  width?: number
}) {
  const raw = clean(props.commit.text)
  const snap = toolSnapshot(props.commit, raw)
  if (!snap) {
    return <RunEntryTextContent commit={props.commit} theme={props.theme.entry} />
  }

  const info = toolFrame(props.commit, raw)
  if (snap.kind === "code") {
    return (
      <CodeTool
        theme={props.theme}
        data={{
          title: snap.title,
          content: snap.content,
          filetype: toolFiletype(snap.file),
          diagnostics: diagnostics(info.meta, snap.file ?? ""),
        }}
      />
    )
  }

  if (snap.kind === "diff") {
    const list = snap.items
      .map((item) => {
        if (!item.diff.trim()) {
          return
        }

        return {
          title: item.title,
          diff: item.diff,
          filetype: toolFiletype(item.file),
          deletions: item.deletions,
          diagnostics: diagnostics(info.meta, item.file ?? ""),
        }
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))

    if (list.length === 0) {
      return <RunEntryTextContent commit={props.commit} theme={props.theme.entry} />
    }

    return (
      <box flexDirection="column" gap={1}>
        <For each={list}>
          {(item) => (
            <DiffTool theme={props.theme} data={item} view={toolDiffView(props.width ?? 80, props.opts?.diffStyle)} />
          )}
        </For>
      </box>
    )
  }

  if (snap.kind === "task") {
    return (
      <TaskTool
        theme={props.theme}
        data={{
          title: snap.title,
          rows: snap.rows,
          tail: snap.tail,
        }}
      />
    )
  }

  if (snap.kind === "todo") {
    return (
      <TodoTool
        theme={props.theme}
        data={{
          items: snap.items,
          tail: snap.tail,
        }}
      />
    )
  }

  return (
    <QuestionTool
      theme={props.theme}
      data={{
        items: snap.items,
        tail: snap.tail,
      }}
    />
  )
}

export function RunEntryContent(props: {
  commit: StreamCommit
  theme?: RunTheme
  opts?: ScrollbackOptions
  width?: number
}) {
  const theme = props.theme ?? RUN_THEME_FALLBACK
  if (snapCommit(props.commit)) {
    return <RunEntrySnapContent commit={props.commit} theme={theme} opts={props.opts} width={props.width} />
  }

  return <RunEntryTextContent commit={props.commit} theme={theme.entry} />
}

function textWriter(commit: StreamCommit, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) =>
    fit(
      createScrollbackWriter(() => <RunEntryTextContent commit={commit} theme={theme} />, {
        width: cols(ctx),
        startOnNewLine: flags.startOnNewLine,
        trailingNewline: flags.trailingNewline,
      })(ctx),
      ctx,
    )
}

function blankWriter(): ScrollbackWriter {
  return (ctx) =>
    createScrollbackWriter(() => <text width="100%" />, {
      width: cols(ctx),
      startOnNewLine: true,
      trailingNewline: true,
    })(ctx)
}

function textBlockWriter(body: string, theme: RunEntryTheme): ScrollbackWriter {
  return (ctx) =>
    full(() => <TextEntry body={body.endsWith("\n") ? body : `${body}\n`} fg={theme.system.body} />, ctx, {
      startOnNewLine: true,
      trailingNewline: false,
    })
}

function flags(commit: StreamCommit): Flags {
  if (commit.kind === "user") {
    return {
      startOnNewLine: true,
      trailingNewline: false,
    }
  }

  if (commit.kind === "tool") {
    if (commit.phase === "progress") {
      return {
        startOnNewLine: false,
        trailingNewline: false,
      }
    }

    return {
      startOnNewLine: true,
      trailingNewline: true,
    }
  }

  if (commit.kind === "assistant" || commit.kind === "reasoning") {
    if (commit.phase === "progress") {
      return {
        startOnNewLine: false,
        trailingNewline: false,
      }
    }

    return {
      startOnNewLine: true,
      trailingNewline: true,
    }
  }

  return {
    startOnNewLine: true,
    trailingNewline: true,
  }
}

export function textEntryWriter(commit: StreamCommit, theme: RunEntryTheme): ScrollbackWriter {
  return textWriter(commit, theme, flags(commit))
}

export function snapEntryWriter(commit: StreamCommit, theme: RunTheme, opts: ScrollbackOptions): ScrollbackWriter {
  const snap = toolSnapshot(commit, clean(commit.text))
  if (!snap) {
    return textEntryWriter(commit, theme.entry)
  }

  const style = flags(commit)

  return (ctx) =>
    full(() => <RunEntrySnapContent commit={commit} theme={theme} opts={opts} width={cols(ctx)} />, ctx, style)
}

export function blockWriter(text: string, theme: RunEntryTheme = RUN_THEME_FALLBACK.entry): ScrollbackWriter {
  return textBlockWriter(clean(text), theme)
}

export function spacerWriter(): ScrollbackWriter {
  return blankWriter()
}
