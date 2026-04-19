// Retained streaming append logic for direct-mode scrollback.
//
// Static entries are rendered through `scrollback.writer.tsx`. This file only
// keeps the minimum retained-surface machinery needed for streaming assistant,
// reasoning, and tool progress entries that need stable markdown/code layout
// while content is still arriving.
import {
  CodeRenderable,
  MarkdownRenderable,
  TextRenderable,
  getTreeSitterClient,
  type TreeSitterClient,
  type CliRenderer,
  type ScrollbackSurface,
} from "@opentui/core"
import { entryBody, entryCanStream, entryDone, entryFlags } from "./entry.body"
import { withRunSpan } from "./otel"
import { entryColor, entryLook, entrySyntax } from "./scrollback.shared"
import { entryWriter, sameEntryGroup, spacerWriter } from "./scrollback.writer"
import { type RunTheme } from "./theme"
import type { RunDiffStyle, RunEntryBody, StreamCommit } from "./types"

type ActiveBody = Exclude<RunEntryBody, { type: "none" | "structured" }>

type ActiveEntry = {
  body: ActiveBody
  commit: StreamCommit
  surface: ScrollbackSurface
  renderable: TextRenderable | CodeRenderable | MarkdownRenderable
  content: string
  committedRows: number
  committedBlocks: number
}

let nextId = 0

function commitMarkdownBlocks(input: {
  surface: ScrollbackSurface
  renderable: MarkdownRenderable
  startBlock: number
  endBlockExclusive: number
  trailingNewline: boolean
}) {
  if (input.endBlockExclusive <= input.startBlock) {
    return false
  }

  const first = input.renderable._blockStates[input.startBlock]
  const last = input.renderable._blockStates[input.endBlockExclusive - 1]
  if (!first || !last) {
    return false
  }

  const prev = input.renderable._blockStates[input.startBlock - 1]
  const next = input.renderable._blockStates[input.endBlockExclusive]
  const start = Math.max(0, first.renderable.y - (prev?.marginBottom ?? 0))
  const end = last.renderable.y + last.renderable.height + (next ? 0 : (last.marginBottom ?? 0))

  input.surface.commitRows(start, end, {
    trailingNewline: input.trailingNewline,
  })
  return true
}

export class RunScrollbackStream {
  private tail: StreamCommit | undefined
  private active: ActiveEntry | undefined
  private wrote: boolean
  private diffStyle: RunDiffStyle | undefined
  private sessionID?: () => string | undefined
  private treeSitterClient: TreeSitterClient | undefined

  constructor(
    private renderer: CliRenderer,
    private theme: RunTheme,
    options: {
      wrote?: boolean
      diffStyle?: RunDiffStyle
      sessionID?: () => string | undefined
      treeSitterClient?: TreeSitterClient
    } = {},
  ) {
    this.wrote = options.wrote ?? true
    this.diffStyle = options.diffStyle
    this.sessionID = options.sessionID
    this.treeSitterClient = options.treeSitterClient ?? getTreeSitterClient()
  }

  private createEntry(commit: StreamCommit, body: ActiveBody): ActiveEntry {
    const surface = this.renderer.createScrollbackSurface({
      startOnNewLine: entryFlags(commit).startOnNewLine,
    })
    const id = `run-scrollback-entry-${nextId++}`
    const style = entryLook(commit, this.theme.entry)
    const renderable =
      body.type === "text"
        ? new TextRenderable(surface.renderContext, {
          id,
          content: "",
          width: "100%",
          wrapMode: "word",
          fg: style.fg,
          attributes: style.attrs,
        })
        : body.type === "code"
          ? new CodeRenderable(surface.renderContext, {
            id,
            content: "",
            filetype: body.filetype,
            syntaxStyle: entrySyntax(commit, this.theme),
            width: "100%",
            wrapMode: "word",
            drawUnstyledText: false,
            streaming: true,
            fg: entryColor(commit, this.theme),
            treeSitterClient: this.treeSitterClient,
          })
          : new MarkdownRenderable(surface.renderContext, {
            id,
            content: "",
            syntaxStyle: entrySyntax(commit, this.theme),
            width: "100%",
            streaming: true,
            internalBlockMode: "top-level",
            tableOptions: { widthMode: "content" },
            fg: entryColor(commit, this.theme),
            treeSitterClient: this.treeSitterClient,
          })

    surface.root.add(renderable)

    return {
      body,
      commit,
      surface,
      renderable,
      content: "",
      committedRows: 0,
      committedBlocks: 0,
    }
  }

  private async flushActive(done: boolean, trailingNewline: boolean): Promise<void> {
    const active = this.active
    if (!active) {
      return
    }

    if (active.body.type === "text") {
      const renderable = active.renderable as TextRenderable
      renderable.content = active.content
      active.surface.render()
      const targetRows = done ? active.surface.height : Math.max(active.committedRows, active.surface.height - 1)
      if (targetRows > active.committedRows) {
        active.surface.commitRows(active.committedRows, targetRows, {
          trailingNewline: done && targetRows === active.surface.height ? trailingNewline : false,
        })
        active.committedRows = targetRows
      }
      return
    }

    if (active.body.type === "code") {
      const renderable = active.renderable as CodeRenderable
      renderable.content = active.content
      renderable.streaming = !done
      await active.surface.settle()
      const targetRows = done ? active.surface.height : Math.max(active.committedRows, active.surface.height - 1)
      if (targetRows > active.committedRows) {
        active.surface.commitRows(active.committedRows, targetRows, {
          trailingNewline: done && targetRows === active.surface.height ? trailingNewline : false,
        })
        active.committedRows = targetRows
      }
      return
    }

    const renderable = active.renderable as MarkdownRenderable
    renderable.content = active.content
    renderable.streaming = !done
    await active.surface.settle()
    const targetBlockCount = done ? renderable._blockStates.length : renderable._stableBlockCount
    if (targetBlockCount <= active.committedBlocks) {
      return
    }

    if (
      commitMarkdownBlocks({
        surface: active.surface,
        renderable,
        startBlock: active.committedBlocks,
        endBlockExclusive: targetBlockCount,
        trailingNewline: done && targetBlockCount === renderable._blockStates.length ? trailingNewline : false,
      })
    ) {
      active.committedBlocks = targetBlockCount
    }
  }

  private async finishActive(trailingNewline: boolean): Promise<void> {
    if (!this.active) {
      return
    }

    const active = this.active

    try {
      await this.flushActive(true, trailingNewline)
    } finally {
      if (this.active === active) {
        this.active = undefined
      }

      if (!active.surface.isDestroyed) {
        active.surface.destroy()
      }
    }
  }

  private async writeStreaming(commit: StreamCommit, body: ActiveBody): Promise<void> {
    if (!this.active || !sameEntryGroup(this.active.commit, commit) || this.active.body.type !== body.type) {
      await this.finishActive(false)
      this.active = this.createEntry(commit, body)
    }

    this.active.body = body
    this.active.commit = commit
    this.active.content += body.content
    await this.flushActive(false, false)
  }

  public async append(commit: StreamCommit): Promise<void> {
    const same = sameEntryGroup(this.tail, commit)
    if (!same) {
      await this.finishActive(false)
    }

    const body = entryBody(commit)
    if (body.type === "none") {
      if (entryDone(commit)) {
        await this.finishActive(entryFlags(commit).trailingNewline)
      }

      this.tail = commit
      return
    }

    if (this.wrote && !same) {
      this.renderer.writeToScrollback(spacerWriter())
    }

    if (
      body.type !== "structured" &&
      (entryCanStream(commit, body) ||
        (commit.kind === "tool" && commit.phase === "final" && body.type === "markdown"))
    ) {
      await this.writeStreaming(commit, body)
      if (entryDone(commit)) {
        await this.finishActive(entryFlags(commit).trailingNewline)
      }
      this.wrote = true
      this.tail = commit
      return
    }

    if (same) {
      await this.finishActive(false)
    }

    this.renderer.writeToScrollback(
      entryWriter({
        commit,
        theme: this.theme,
        opts: {
          diffStyle: this.diffStyle,
        },
      }),
    )
    this.wrote = true
    this.tail = commit
  }

  private resetActive(): void {
    if (!this.active) {
      return
    }

    if (!this.active.surface.isDestroyed) {
      this.active.surface.destroy()
    }

    this.active = undefined
  }

  public async complete(trailingNewline = false): Promise<void> {
    return withRunSpan(
      "RunScrollbackStream.complete",
      {
        "opencode.entry.active": !!this.active,
        "opencode.trailing_newline": trailingNewline,
        "session.id": this.sessionID?.() || undefined,
      },
      async () => {
        await this.finishActive(trailingNewline)
      },
    )
  }

  public destroy(): void {
    this.resetActive()
  }
}
