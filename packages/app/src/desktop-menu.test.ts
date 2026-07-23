import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.label === "Export Logs...",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("puts browser navigation in History and reload in View", () => {
    const history = DESKTOP_MENU.find((menu) => menu.id === "history")
    const view = DESKTOP_MENU.find((menu) => menu.id === "view")

    expect(history?.items).toEqual([
      {
        type: "item",
        label: "Back",
        action: "history.back",
        accelerator: { macos: "Cmd+[", windows: "Alt+Left" },
      },
      {
        type: "item",
        label: "Forward",
        action: "history.forward",
        accelerator: { macos: "Cmd+]", windows: "Alt+Right" },
      },
    ])
    expect(view?.items?.some((item) => item.type === "item" && item.action === "view.reload")).toBe(true)
  })
})
