import { expect, test } from "bun:test"
import { RGBA, SyntaxStyle, type CliRenderer, type TerminalColors } from "@opentui/core"
import { opaqueSyntaxStyle, resolveRunTheme } from "@/cli/cmd/run/theme"
import { generateSystem, resolveTheme } from "@/cli/cmd/tui/context/theme"

test("flattens subtle syntax alpha against the run background", () => {
  const syntax = SyntaxStyle.fromStyles({
    default: {
      fg: RGBA.fromInts(169, 177, 214, 153),
    },
    emphasis: {
      fg: RGBA.fromInts(224, 175, 104, 153),
      italic: true,
      bold: true,
    },
  })
  const subtle = opaqueSyntaxStyle(syntax, RGBA.fromInts(42, 43, 61))

  try {
    expect(subtle?.getStyle("default")?.fg?.toInts()).toEqual([118, 123, 153, 255])
    expect(subtle?.getStyle("emphasis")?.fg?.toInts()).toEqual([151, 122, 87, 255])
    expect(subtle?.getStyle("emphasis")?.italic).toBe(true)
    expect(subtle?.getStyle("emphasis")?.bold).toBe(true)
  } finally {
    syntax.destroy()
    subtle?.destroy()
  }
})

const colors: TerminalColors = {
  palette: [
    "#15161e",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#a9b1d6",
    "#414868",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#c0caf5",
  ],
  defaultBackground: "#1a1b26",
  defaultForeground: "#c0caf5",
  cursorColor: "#ff9e64",
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightBackground: "#33467c",
  highlightForeground: "#c0caf5",
}

function renderer(themeMode: "dark" | "light") {
  const item = {
    themeMode,
    getPalette: async () => colors,
  } satisfies Pick<CliRenderer, "themeMode" | "getPalette">

  return item as CliRenderer
}

test("system theme uses terminal ui colors for primary", () => {
  const theme = resolveTheme(generateSystem(colors, "dark"), "dark")

  expect(theme.primary).toEqual(RGBA.fromHex(colors.cursorColor!))
  expect(theme.primary).not.toEqual(RGBA.fromHex(colors.palette[6]!))
})

test("resolve run theme uses the system primary for footer highlight", async () => {
  const expected = resolveTheme(generateSystem(colors, "dark"), "dark")
  const theme = await resolveRunTheme(renderer("dark"))

  expect(theme.footer.highlight).toEqual(expected.primary)
})
