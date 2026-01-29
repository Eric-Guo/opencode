import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, toolPart, userMessage } from "../utils/timeline"

for (const row of [
  { locale: "zh", lang: "zh-Hans", label: "使用了 2 个 读取和Glob" },
  { locale: "de", lang: "en", label: "Used 2 Read, Glob" },
] as const) {
  test(`projects tool names in ${row.locale}, falling back to English for unsupported locales`, async ({ page }) => {
    const locale = row.locale
    const ids = [`prt_locale_${locale}_01_read`, `prt_locale_${locale}_02_glob`]
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([
          toolPart(ids[0]!, "read", "completed", { path: "src/a.ts" }),
          toolPart(ids[1]!, "glob", "completed", { path: ".", pattern: "**/*.ts" }),
        ]),
      ],
      locale,
    })

    const group = page.locator(`[data-timeline-part-ids="${ids.join(",")}"]`)
    await expect(group.getByRole("button")).toHaveAccessibleName(row.label)
    await expect(group.locator('[data-component="context-tool-group-trigger"]')).toHaveAttribute(
      "aria-label",
      row.label,
    )
    await expect(page.locator("html")).toHaveAttribute("lang", row.lang)
  })
}
