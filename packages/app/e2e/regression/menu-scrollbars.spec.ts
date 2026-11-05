import { expect, test, type Locator, type Page } from "@playwright/test"
import { openPaletteWorkspace, paletteSession } from "../utils/command-palette"
import { openSettings } from "../utils/workspace"

// Headless Chromium hides scrollbars by default, so a native scrollbar would take no width and the contract below
// could not fail.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } })

async function geometry(row: Locator) {
  return row.evaluate((item) => {
    const viewport = item.closest<HTMLElement>('[data-component="menu-scroll"] > [data-scrollable]')

    if (!viewport?.isConnected) return

    const box = viewport.getBoundingClientRect()
    const rect = item.getBoundingClientRect()

    return {
      overflow: viewport.scrollHeight > viewport.clientHeight,
      scrollbar: viewport.offsetWidth - viewport.clientWidth,
      insetDelta: Math.round(rect.left - box.left) - Math.round(box.right - rect.right),
    }
  })
}

const surfaces = [
  {
    name: "a search list",
    async open(page: Page) {
      await openPaletteWorkspace(page, true, [
        { ...paletteSession, time: { ...paletteSession.time } },
        ...Array.from({ length: 23 }, (_, index) => ({
          ...paletteSession,
          id: `ses_menu_scrollbar_${index}`,
          title: `Overflowing result ${index}`,
          time: { created: 1700000000000 - index - 1, updated: 1700000000000 - index - 1 },
        })),
      ])
      await page.getByRole("banner").getByRole("button", { name: "Search sessions", exact: true }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByRole("combobox").fill("Overflowing")
      await expect(dialog.getByRole("option")).toHaveCount(23)

      return dialog.getByRole("option", { name: /Overflowing result 0/ })
    },
  },
  {
    name: "a select",
    async open(page: Page) {
      const view = await openSettings(page, { name: "Menu scrollbars" })
      await view.settings.getByRole("tab", { name: "Appearance", exact: true }).click()
      // Bundled themes fill the menu even in distributions with only a few locales.
      await view.settings.locator('[data-action="settings-theme"]').click()

      return page.getByRole("listbox").getByRole("option", { name: "OpenCode", exact: true })
    },
  },
]

for (const surface of surfaces) {
  test(`${surface.name} overlays its scrollbar so rows keep equal insets while it overflows`, async ({ page }) => {
    const row = await surface.open(page)

    await expect.poll(() => geometry(row)).toEqual({ overflow: true, scrollbar: 0, insetDelta: 0 })

    await page.emulateMedia({ forcedColors: "active" })
    await expect.poll(async () => (await geometry(row))?.scrollbar ?? 0).toBeGreaterThan(0)
  })
}
