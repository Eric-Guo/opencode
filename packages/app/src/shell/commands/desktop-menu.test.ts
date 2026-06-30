import { expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

test("puts browser navigation in History and reload in View", () => {
  const history = DESKTOP_MENU.find((menu) => menu.id === "history")
  const view = DESKTOP_MENU.find((menu) => menu.id === "view")

  expect(history?.items).toEqual([
    {
      type: "item",
      labelKey: "desktop.menu.back",
      action: "history.back",
      accelerator: { macos: "Cmd+[", windows: "Alt+Left" },
    },
    {
      type: "item",
      labelKey: "desktop.menu.forward",
      action: "history.forward",
      accelerator: { macos: "Cmd+]", windows: "Alt+Right" },
    },
  ])
  expect(view?.items?.some((item) => item.type === "item" && item.action === "view.reload")).toBe(true)
})
