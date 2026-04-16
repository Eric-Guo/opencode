// Theme resolution for direct interactive mode.
//
// Derives scrollback and footer colors from the terminal's actual palette.
// resolveRunTheme() queries the renderer for the terminal's 16-color palette,
// detects dark/light mode, and maps through the TUI's theme system to produce
// a RunTheme. Falls back to a hardcoded dark-mode palette if detection fails.
//
// The theme has three parts:
//   entry  → per-EntryKind colors for plain scrollback text
//   footer → highlight, muted, text, surface, and line colors for the footer
//   block  → richer text/syntax/diff colors for static tool snapshots
import { RGBA, SyntaxStyle, type CliRenderer, type ColorInput } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { EntryKind } from "./types"

type Tone = {
  body: ColorInput
  start?: ColorInput
}

export type RunEntryTheme = Record<EntryKind, Tone>

export type RunFooterTheme = {
  highlight: ColorInput
  warning: ColorInput
  success: ColorInput
  error: ColorInput
  muted: ColorInput
  text: ColorInput
  shade: ColorInput
  surface: ColorInput
  pane: ColorInput
  border: ColorInput
  line: ColorInput
}

export type RunBlockTheme = {
  text: ColorInput
  muted: ColorInput
  syntax?: SyntaxStyle
  diffAdded: ColorInput
  diffRemoved: ColorInput
  diffAddedBg: ColorInput
  diffRemovedBg: ColorInput
  diffContextBg: ColorInput
  diffHighlightAdded: ColorInput
  diffHighlightRemoved: ColorInput
  diffLineNumber: ColorInput
  diffAddedLineNumberBg: ColorInput
  diffRemovedLineNumberBg: ColorInput
}

export type RunTheme = {
  background: ColorInput
  footer: RunFooterTheme
  entry: RunEntryTheme
  block: RunBlockTheme
}

export const transparent = RGBA.fromValues(0, 0, 0, 0)

function alpha(color: RGBA, value: number): RGBA {
  const a = Math.max(0, Math.min(1, value))
  return RGBA.fromValues(color.r, color.g, color.b, a)
}

function rgba(hex: string, value?: number): RGBA {
  const color = RGBA.fromHex(hex)
  if (value === undefined) {
    return color
  }

  return alpha(color, value)
}

function mode(bg: RGBA): "dark" | "light" {
  const lum = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b
  if (lum > 0.5) {
    return "light"
  }

  return "dark"
}

function fade(color: RGBA, base: RGBA, fallback: number, scale: number, limit: number): RGBA {
  if (color.a === 0) {
    return alpha(color, fallback)
  }

  const target = Math.min(limit, color.a * scale)
  const mix = Math.min(1, target / color.a)

  return RGBA.fromValues(
    base.r + (color.r - base.r) * mix,
    base.g + (color.g - base.g) * mix,
    base.b + (color.b - base.b) * mix,
    color.a,
  )
}

function map(theme: TuiThemeCurrent, syntax?: SyntaxStyle): RunTheme {
  const bg = theme.background
  const pane = theme.backgroundElement
  const shade = fade(pane, bg, 0.12, 0.56, 0.72)
  const surface = fade(pane, bg, 0.18, 0.76, 0.9)
  const line = fade(pane, bg, 0.24, 0.9, 0.98)

  return {
    background: theme.background,
    footer: {
      highlight: theme.primary,
      warning: theme.warning,
      success: theme.success,
      error: theme.error,
      muted: theme.textMuted,
      text: theme.text,
      shade,
      surface,
      pane,
      border: theme.border,
      line,
    },
    entry: {
      system: {
        body: theme.textMuted,
      },
      user: {
        body: theme.primary,
      },
      assistant: {
        body: theme.text,
      },
      reasoning: {
        body: theme.textMuted,
      },
      tool: {
        body: theme.text,
        start: theme.textMuted,
      },
      error: {
        body: theme.error,
      },
    },
    block: {
      text: theme.text,
      muted: theme.textMuted,
      syntax,
      diffAdded: theme.diffAdded,
      diffRemoved: theme.diffRemoved,
      diffAddedBg: theme.diffAddedBg,
      diffRemovedBg: theme.diffRemovedBg,
      diffContextBg: theme.diffContextBg,
      diffHighlightAdded: theme.diffHighlightAdded,
      diffHighlightRemoved: theme.diffHighlightRemoved,
      diffLineNumber: theme.diffLineNumber,
      diffAddedLineNumberBg: theme.diffAddedLineNumberBg,
      diffRemovedLineNumberBg: theme.diffRemovedLineNumberBg,
    },
  }
}

const seed = {
  highlight: rgba("#38bdf8"),
  muted: rgba("#64748b"),
  text: rgba("#f8fafc"),
  panel: rgba("#0f172a"),
  success: rgba("#22c55e"),
  warning: rgba("#f59e0b"),
  error: rgba("#ef4444"),
}

function tone(body: ColorInput, start?: ColorInput): Tone {
  return {
    body,
    start,
  }
}

export const RUN_THEME_FALLBACK: RunTheme = {
  background: RGBA.fromValues(0, 0, 0, 0),
  footer: {
    highlight: seed.highlight,
    warning: seed.warning,
    success: seed.success,
    error: seed.error,
    muted: seed.muted,
    text: seed.text,
    shade: alpha(seed.panel, 0.68),
    surface: alpha(seed.panel, 0.86),
    pane: seed.panel,
    border: seed.muted,
    line: alpha(seed.panel, 0.96),
  },
  entry: {
    system: tone(seed.muted),
    user: tone(seed.highlight),
    assistant: tone(seed.text),
    reasoning: tone(seed.muted),
    tool: tone(seed.text, seed.muted),
    error: tone(seed.error),
  },
  block: {
    text: seed.text,
    muted: seed.muted,
    diffAdded: seed.success,
    diffRemoved: seed.error,
    diffAddedBg: alpha(seed.success, 0.18),
    diffRemovedBg: alpha(seed.error, 0.18),
    diffContextBg: alpha(seed.panel, 0.72),
    diffHighlightAdded: seed.success,
    diffHighlightRemoved: seed.error,
    diffLineNumber: seed.muted,
    diffAddedLineNumberBg: alpha(seed.success, 0.12),
    diffRemovedLineNumberBg: alpha(seed.error, 0.12),
  },
}

export async function resolveRunTheme(renderer: CliRenderer): Promise<RunTheme> {
  try {
    const colors = await renderer.getPalette({
      size: 16,
    })
    const bg = colors.defaultBackground ?? colors.palette[0]
    if (!bg) {
      return RUN_THEME_FALLBACK
    }

    const pick = renderer.themeMode ?? mode(RGBA.fromHex(bg))
    const mod = await import("../tui/context/theme")
    const theme = mod.resolveTheme(mod.generateSystem(colors, pick), pick) as TuiThemeCurrent
    try {
      return map(theme, mod.generateSyntax(theme))
    } catch {
      return map(theme)
    }
  } catch {
    return RUN_THEME_FALLBACK
  }
}
