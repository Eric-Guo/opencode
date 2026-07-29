/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { resolveThemeDocument } from "@opencode/theme/tui"
import WhichKey from "../src/feature-plugins/system/which-key"
import { getOpenCodeTheme } from "../src/theme"

test("WhichKey home hint renders with the production theme", async () => {
  const slots: Array<{ append: string; render: () => JSX.Element }> = []
  WhichKey.setup({
    theme: resolveThemeDocument(getOpenCodeTheme(), "dark"),
    keymap: { shortcuts: () => ["ctrl+k"] },
    ui: { slot: (slot: { append: string; render: () => JSX.Element }) => slots.push(slot) },
  } as unknown as Plugin.Context)
  const hint = slots.find((slot) => slot.append === "home.footer")!
  const app = await testRender(hint.render, { width: 80, height: 3 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Show keyboard shortcuts")
  } finally {
    app.renderer.destroy()
  }
})
