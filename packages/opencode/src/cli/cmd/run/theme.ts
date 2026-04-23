// Theme resolution for direct interactive mode.
//
// Derives scrollback and footer colors from the terminal's actual palette.
// resolveRunTheme() queries the renderer for the terminal's 16-color palette,
// detects dark/light mode, builds a small system theme locally, and maps it to
// the run footer + scrollback color model. Falls back to a hardcoded dark-mode
// palette if detection fails.
import { RGBA, SyntaxStyle, type CliRenderer, type ColorInput, type TerminalColors } from "@opentui/core"
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
  subtleSyntax?: SyntaxStyle
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

type ThemeColor = Exclude<keyof TuiThemeCurrent, "thinkingOpacity">
type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant | RGBA | number
type ThemeJson = {
  defs?: Record<string, HexColor | RefName>
  theme: Omit<Record<ThemeColor, ColorValue>, "selectedListItemText" | "backgroundMenu"> & {
    selectedListItemText?: ColorValue
    backgroundMenu?: ColorValue
    thinkingOpacity?: number
  }
}

export const transparent = RGBA.fromValues(0, 0, 0, 0)

function alpha(color: RGBA, value: number): RGBA {
  return RGBA.fromValues(color.r, color.g, color.b, Math.max(0, Math.min(1, value)))
}

function rgba(hex: string, value?: number): RGBA {
  const color = RGBA.fromHex(hex)
  return value === undefined ? color : alpha(color, value)
}

function mode(bg: RGBA): "dark" | "light" {
  const lum = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b
  return lum > 0.5 ? "light" : "dark"
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

function ansiToRgba(code: number): RGBA {
  if (code < 16) {
    const ansi = [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ]
    return RGBA.fromHex(ansi[code] ?? "#000000")
  }

  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)
    const value = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(value(r), value(g), value(b))
  }

  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }

  return RGBA.fromInts(0, 0, 0)
}

function tint(base: RGBA, overlay: RGBA, value: number): RGBA {
  return RGBA.fromInts(
    Math.round((base.r + (overlay.r - base.r) * value) * 255),
    Math.round((base.g + (overlay.g - base.g) * value) * 255),
    Math.round((base.b + (overlay.b - base.b) * value) * 255),
  )
}

function luminance(color: RGBA) {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

function chroma(color: RGBA) {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b)
}

export function resolveTheme(theme: ThemeJson, pick: "dark" | "light"): TuiThemeCurrent {
  const defs = theme.defs ?? {}

  const resolveColor = (value: ColorValue, chain: string[] = []): RGBA => {
    if (value instanceof RGBA) return value

    if (typeof value === "number") {
      return ansiToRgba(value)
    }

    if (typeof value !== "string") {
      return resolveColor(value[pick], chain)
    }

    if (value === "transparent" || value === "none") {
      return RGBA.fromInts(0, 0, 0, 0)
    }

    if (value.startsWith("#")) {
      return RGBA.fromHex(value)
    }

    if (chain.includes(value)) {
      throw new Error(`Circular color reference: ${[...chain, value].join(" -> ")}`)
    }

    const next = defs[value] ?? theme.theme[value as ThemeColor]
    if (next === undefined) {
      throw new Error(`Color reference "${value}" not found in defs or theme`)
    }

    return resolveColor(next, [...chain, value])
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(([key]) => key !== "selectedListItemText" && key !== "backgroundMenu" && key !== "thinkingOpacity")
      .map(([key, value]) => [key, resolveColor(value as ColorValue)]),
  ) as Partial<Record<ThemeColor, RGBA>>

  return {
    ...(resolved as Record<ThemeColor, RGBA>),
    selectedListItemText:
      theme.theme.selectedListItemText === undefined
        ? resolved.background!
        : resolveColor(theme.theme.selectedListItemText),
    backgroundMenu:
      theme.theme.backgroundMenu === undefined ? resolved.backgroundElement! : resolveColor(theme.theme.backgroundMenu),
    thinkingOpacity: theme.theme.thinkingOpacity ?? 0.6,
  }
}

function pickPrimaryColor(
  bg: RGBA,
  candidates: Array<{
    key: string
    color: RGBA | undefined
  }>,
) {
  return candidates
    .flatMap((item) => {
      if (!item.color) return []
      const contrast = Math.abs(luminance(item.color) - luminance(bg))
      const vivid = chroma(item.color)
      if (contrast < 0.16 || vivid < 0.12) return []
      return [{ key: item.key, color: item.color, score: vivid * 1.5 + contrast }]
    })
    .sort((a, b) => b.score - a.score)[0]
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const r = bg.r * 255
  const g = bg.g * 255
  const b = bg.b * 255
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  const cast = 0.25 * (1 - chroma(bg)) ** 2

  const gray = (level: number) => {
    const factor = level / 12

    if (isDark && lum < 10) {
      const value = Math.floor(factor * 0.4 * 255)
      return RGBA.fromInts(value, value, value)
    }

    if (!isDark && lum > 245) {
      const value = Math.floor(255 - factor * 0.4 * 255)
      return RGBA.fromInts(value, value, value)
    }

    const value = isDark ? lum + (255 - lum) * factor * 0.4 : lum * (1 - factor * 0.4)
    const tone = RGBA.fromInts(Math.floor(value), Math.floor(value), Math.floor(value))
    if (cast === 0) return tone

    const ratio = lum === 0 ? 0 : value / lum
    return tint(
      tone,
      RGBA.fromInts(
        Math.floor(Math.max(0, Math.min(r * ratio, 255))),
        Math.floor(Math.max(0, Math.min(g * ratio, 255))),
        Math.floor(Math.max(0, Math.min(b * ratio, 255))),
      ),
      cast,
    )
  }

  return Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, gray(index + 1)]))
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  const lum = 0.299 * bg.r * 255 + 0.587 * bg.g * 255 + 0.114 * bg.b * 255
  const gray = isDark
    ? lum < 10
      ? 180
      : Math.min(Math.floor(160 + lum * 0.3), 200)
    : lum > 245
      ? 75
      : Math.max(Math.floor(100 - (255 - lum) * 0.2), 60)

  return RGBA.fromInts(gray, gray, gray)
}

export function generateSystem(colors: TerminalColors, pick: "dark" | "light"): ThemeJson {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const isDark = pick === "dark"
  const grays = generateGrayScale(bg, isDark)
  const textMuted = generateMutedTextColor(bg, isDark)

  const color = (index: number) => {
    const value = colors.palette[index]
    return value ? RGBA.fromHex(value) : ansiToRgba(index)
  }

  const ansi = {
    red: color(1),
    green: color(2),
    yellow: color(3),
    blue: color(4),
    magenta: color(5),
    cyan: color(6),
    red_bright: color(9),
    green_bright: color(10),
  }

  const diff_alpha = isDark ? 0.22 : 0.14
  const diff_context_bg = grays[2]
  const primary =
    pickPrimaryColor(bg, [
      {
        key: "cursor",
        color: colors.cursorColor ? RGBA.fromHex(colors.cursorColor) : undefined,
      },
      {
        key: "selection",
        color: colors.highlightBackground ? RGBA.fromHex(colors.highlightBackground) : undefined,
      },
      {
        key: "blue",
        color: ansi.blue,
      },
      {
        key: "magenta",
        color: ansi.magenta,
      },
    ]) ?? {
      key: "blue",
      color: ansi.blue,
    }

  return {
    theme: {
      primary: primary.color,
      secondary: primary.key === "magenta" ? ansi.blue : ansi.magenta,
      accent: primary.color,
      error: ansi.red,
      warning: ansi.yellow,
      success: ansi.green,
      info: ansi.cyan,
      text: fg,
      textMuted,
      selectedListItemText: bg,
      background: RGBA.fromValues(bg.r, bg.g, bg.b, 0),
      backgroundPanel: grays[2],
      backgroundElement: grays[3],
      backgroundMenu: grays[3],
      borderSubtle: grays[6],
      border: grays[7],
      borderActive: grays[8],
      diffAdded: ansi.green,
      diffRemoved: ansi.red,
      diffContext: grays[7],
      diffHunkHeader: grays[7],
      diffHighlightAdded: ansi.green_bright,
      diffHighlightRemoved: ansi.red_bright,
      diffAddedBg: tint(bg, ansi.green, diff_alpha),
      diffRemovedBg: tint(bg, ansi.red, diff_alpha),
      diffContextBg: diff_context_bg,
      diffLineNumber: textMuted,
      diffAddedLineNumberBg: tint(diff_context_bg, ansi.green, diff_alpha),
      diffRemovedLineNumberBg: tint(diff_context_bg, ansi.red, diff_alpha),
      markdownText: fg,
      markdownHeading: fg,
      markdownLink: ansi.blue,
      markdownLinkText: ansi.cyan,
      markdownCode: ansi.green,
      markdownBlockQuote: ansi.yellow,
      markdownEmph: ansi.yellow,
      markdownStrong: fg,
      markdownHorizontalRule: grays[7],
      markdownListItem: ansi.blue,
      markdownListEnumeration: ansi.cyan,
      markdownImage: ansi.blue,
      markdownImageText: ansi.cyan,
      markdownCodeBlock: fg,
      syntaxComment: textMuted,
      syntaxKeyword: ansi.magenta,
      syntaxFunction: ansi.blue,
      syntaxVariable: fg,
      syntaxString: ansi.green,
      syntaxNumber: ansi.yellow,
      syntaxType: ansi.cyan,
      syntaxOperator: ansi.cyan,
      syntaxPunctuation: fg,
    },
  }
}

function generateSyntax(theme: TuiThemeCurrent) {
  return SyntaxStyle.fromTheme([
    {
      scope: ["default"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["comment", "comment.documentation"],
      style: {
        foreground: theme.syntaxComment,
        italic: true,
      },
    },
    {
      scope: ["string", "symbol", "character", "markup.raw", "markup.raw.block", "markup.raw.inline"],
      style: {
        foreground: theme.markdownCode,
      },
    },
    {
      scope: ["number", "boolean", "constant"],
      style: {
        foreground: theme.syntaxNumber,
      },
    },
    {
      scope: ["keyword", "keyword.import", "keyword.operator"],
      style: {
        foreground: theme.syntaxKeyword,
        italic: true,
      },
    },
    {
      scope: ["function", "function.call", "function.method", "function.method.call", "constructor"],
      style: {
        foreground: theme.syntaxFunction,
      },
    },
    {
      scope: ["type", "class", "module", "namespace"],
      style: {
        foreground: theme.syntaxType,
      },
    },
    {
      scope: ["operator", "punctuation.delimiter", "punctuation.special"],
      style: {
        foreground: theme.syntaxOperator,
      },
    },
    {
      scope: ["markup.heading"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.link", "markup.link.url", "markup.link.label", "string.special.url"],
      style: {
        foreground: theme.markdownLink,
        underline: true,
      },
    },
    {
      scope: ["diff.plus"],
      style: {
        foreground: theme.diffAdded,
        background: theme.diffAddedBg,
      },
    },
    {
      scope: ["diff.minus"],
      style: {
        foreground: theme.diffRemoved,
        background: theme.diffRemovedBg,
      },
    },
    {
      scope: ["diff.delta"],
      style: {
        foreground: theme.diffContext,
        background: theme.diffContextBg,
      },
    },
    {
      scope: ["error"],
      style: {
        foreground: theme.error,
        bold: true,
      },
    },
    {
      scope: ["warning"],
      style: {
        foreground: theme.warning,
        bold: true,
      },
    },
  ])
}

function map(theme: TuiThemeCurrent, syntax?: SyntaxStyle): RunTheme {
  const shade = fade(theme.backgroundElement, theme.background, 0.12, 0.56, 0.72)
  const surface = fade(theme.backgroundElement, theme.background, 0.18, 0.76, 0.9)
  const line = fade(theme.backgroundElement, theme.background, 0.24, 0.9, 0.98)

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
      pane: theme.backgroundElement,
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
    const theme = resolveTheme(generateSystem(colors, pick), pick)
    return map(theme, generateSyntax(theme))
  } catch {
    return RUN_THEME_FALLBACK
  }
}
