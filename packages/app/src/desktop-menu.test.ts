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

  test("reopens closed tabs through the command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.command === "tab.reopenClosed",
    )

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      label: "Reopen Closed Tab",
      accelerator: { macos: "Shift+Cmd+T" },
    })
    expect(items[0]?.type === "item" && !items[0].action).toBe(true)
  })
})
