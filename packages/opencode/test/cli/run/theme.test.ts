import { expect, test } from "bun:test"
import { RGBA, type CliRenderer, type TerminalColors } from "@opentui/core"
import { generateSystem, resolveRunTheme, resolveTheme } from "@/cli/cmd/run/theme"

test("resolve run theme keeps block syntax intentionally simple", async () => {
  const theme = await resolveRunTheme(renderer("dark"))
  try {
    expect(theme.block.subtleSyntax).toBeUndefined()
    expect(theme.block.syntax?.getStyle("keyword")?.fg).toEqual(RGBA.fromHex(colors.palette[5]!))
    expect(theme.block.syntax?.getStyle("string")?.fg).toEqual(RGBA.fromHex(colors.palette[2]!))
  } finally {
    theme.block.syntax?.destroy()
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

function spread(color: RGBA) {
  const [r, g, b] = color.toInts()
  return Math.max(r, g, b) - Math.min(r, g, b)
}

function system(defaultBackground: string, defaultForeground: string, mode: "dark" | "light") {
  return resolveTheme(
    generateSystem(
      {
        ...colors,
        defaultBackground,
        defaultForeground,
      },
      mode,
    ),
    mode,
  )
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

test("system theme keeps dark surfaces close to neutral on colored backgrounds", () => {
  const theme = system("#002b36", "#93a1a1", "dark")

  expect(spread(theme.backgroundPanel)).toBeLessThan(25)
  expect(spread(theme.backgroundElement)).toBeLessThan(25)
})

test("system theme keeps light surfaces close to neutral on warm backgrounds", () => {
  const theme = system("#fbf1c7", "#3c3836", "light")

  expect(spread(theme.backgroundPanel)).toBeLessThan(20)
  expect(spread(theme.backgroundElement)).toBeLessThan(20)
})

test("system theme keeps dark surfaces neutral on saturated backgrounds", () => {
  const theme = system("#0000ff", "#ffffff", "dark")

  expect(spread(theme.backgroundPanel)).toBeLessThan(5)
  expect(spread(theme.backgroundElement)).toBeLessThan(5)
})

test("system theme keeps light surfaces neutral on saturated backgrounds", () => {
  const theme = system("#ffff00", "#000000", "light")

  expect(spread(theme.backgroundPanel)).toBeLessThan(5)
  expect(spread(theme.backgroundElement)).toBeLessThan(5)
})
