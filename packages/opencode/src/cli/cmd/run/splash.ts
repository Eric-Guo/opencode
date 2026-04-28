// Entry and exit splash banners for direct interactive mode scrollback.
//
// Renders the opencode ASCII logo with half-block shadow characters, the
// session title, and contextual hints (entry: "/exit to finish", exit:
// "opencode -s <id>" to resume). These are scrollback snapshots, so they
// become immutable terminal history once committed.
//
// The logo uses a cell-based renderer. cells() classifies each character
// in the logo template as text, full-block, half-block-mix, or
// half-block-top, and draw() renders it with foreground/background shadow
// colors from the theme.
import {
  BoxRenderable,
  type ColorInput,
  RGBA,
  TextAttributes,
  TextRenderable,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import * as Locale from "@/util/locale"
import { logo } from "@/cli/logo"
import type { RunSplashTheme } from "./theme"

export const SPLASH_TITLE_LIMIT = 50
export const SPLASH_TITLE_FALLBACK = "Untitled session"

type SplashInput = {
  title: string | undefined
  session_id: string
}

type SplashWriterInput = SplashInput & {
  theme: RunSplashTheme
  showSession?: boolean
}

export type SplashMeta = {
  title: string
  session_id: string
}

type Cell = {
  char: string
  mark: "text" | "full" | "mix" | "top"
}

let id = 0

function cells(line: string): Cell[] {
  const list: Cell[] = []
  for (const char of line) {
    if (char === "_") {
      list.push({ char: " ", mark: "full" })
      continue
    }

    if (char === "^") {
      list.push({ char: "▀", mark: "mix" })
      continue
    }

    if (char === "~") {
      list.push({ char: "▀", mark: "top" })
      continue
    }

    list.push({ char, mark: "text" })
  }

  return list
}

function title(text: string | undefined): string {
  if (!text) {
    return SPLASH_TITLE_FALLBACK
  }

  if (!text.trim()) {
    return SPLASH_TITLE_FALLBACK
  }

  return Locale.truncate(text.trim(), SPLASH_TITLE_LIMIT)
}

function write(
  root: BoxRenderable,
  ctx: ScrollbackRenderContext,
  line: {
    left: number
    top: number
    text: string
    fg: ColorInput
    bg?: ColorInput
    attrs?: number
  },
): void {
  if (line.left >= ctx.width) {
    return
  }

  root.add(
    new TextRenderable(ctx.renderContext, {
      id: `run-direct-splash-line-${id++}`,
      position: "absolute",
      left: line.left,
      top: line.top,
      width: Math.max(1, ctx.width - line.left),
      height: 1,
      wrapMode: "none",
      content: line.text,
      fg: line.fg,
      bg: line.bg,
      attributes: line.attrs,
    }),
  )
}

function push(
  lines: Array<{ left: number; top: number; text: string; fg: ColorInput; bg?: ColorInput; attrs?: number }>,
  left: number,
  top: number,
  text: string,
  fg: ColorInput,
  bg?: ColorInput,
  attrs?: number,
): void {
  lines.push({ left, top, text, fg, bg, attrs })
}

function color(input: ColorInput, fallback: RGBA): RGBA {
  if (input instanceof RGBA) {
    return input
  }

  if (typeof input === "string") {
    if (input === "transparent" || input === "none") {
      return RGBA.fromValues(0, 0, 0, 0)
    }

    if (input.startsWith("#")) {
      return RGBA.fromHex(input)
    }
  }

  return fallback
}

function fallback(index: number, hex: string): RGBA {
  return RGBA.fromIndex(index, RGBA.fromHex(hex))
}

function draw(
  lines: Array<{ left: number; top: number; text: string; fg: ColorInput; bg?: ColorInput; attrs?: number }>,
  row: string,
  input: {
    left: number
    top: number
    fg: ColorInput
    shadow: ColorInput
    attrs?: number
  },
) {
  let x = input.left
  for (const cell of cells(row)) {
    if (cell.mark === "full" || cell.mark === "mix") {
      push(lines, x, input.top, cell.char, input.fg, input.shadow, input.attrs)
      x += 1
      continue
    }

    if (cell.mark === "top") {
      push(lines, x, input.top, cell.char, input.shadow, undefined, input.attrs)
      x += 1
      continue
    }

    push(lines, x, input.top, cell.char, input.fg, undefined, input.attrs)
    x += 1
  }
}

function build(input: SplashWriterInput, kind: "entry" | "exit", ctx: ScrollbackRenderContext): ScrollbackSnapshot {
  const width = Math.max(1, ctx.width)
  const meta = splashMeta(input)
  const lines: Array<{ left: number; top: number; text: string; fg: ColorInput; bg?: ColorInput; attrs?: number }> = []
  const left = color(input.theme.left, fallback(81, "#38bdf8"))
  const right = color(input.theme.right, RGBA.defaultForeground(RGBA.fromHex("#f8fafc")))
  const leftShadow = color(input.theme.leftShadow, fallback(238, "#334155"))
  const rightShadow = color(input.theme.rightShadow, fallback(240, "#475569"))
  let y = 0

  for (let i = 0; i < logo.left.length; i += 1) {
    const leftText = logo.left[i] ?? ""
    const rightText = logo.right[i] ?? ""

    draw(lines, leftText, {
      left: 0,
      top: y,
      fg: left,
      shadow: leftShadow,
    })
    draw(lines, rightText, {
      left: leftText.length + 1,
      top: y,
      fg: right,
      shadow: rightShadow,
    })
    y += 1
  }

  y += 1

  if (input.showSession !== false) {
    const label = "Session".padEnd(10, " ")
    push(lines, 0, y, label, input.theme.left, undefined, TextAttributes.DIM)
    push(lines, label.length, y, meta.title, input.theme.right, undefined, TextAttributes.BOLD)
    y += 1
  }

  if (kind === "entry") {
    push(lines, 0, y, "Type /exit to finish.", input.theme.left, undefined, undefined)
    y += 1
  }

  if (kind === "exit") {
    const next = "Continue".padEnd(10, " ")
    push(lines, 0, y, next, input.theme.left, undefined, TextAttributes.DIM)
    push(
      lines,
      next.length,
      y,
      `opencode -s ${meta.session_id}`,
      input.theme.right,
      undefined,
      TextAttributes.BOLD,
    )
    y += 1
  }

  const height = Math.max(1, y)
  const root = new BoxRenderable(ctx.renderContext, {
    id: `run-direct-splash-${kind}-${id++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height,
  })

  for (const line of lines) {
    write(root, ctx, line)
  }

  return {
    root,
    width,
    height,
    rowColumns: width,
    startOnNewLine: true,
    trailingNewline: false,
  }
}

export function splashMeta(input: SplashInput): SplashMeta {
  return {
    title: title(input.title),
    session_id: input.session_id,
  }
}

export function entrySplash(input: SplashWriterInput): ScrollbackWriter {
  return (ctx) => build(input, "entry", ctx)
}

export function exitSplash(input: SplashWriterInput): ScrollbackWriter {
  return (ctx) => build(input, "exit", ctx)
}
