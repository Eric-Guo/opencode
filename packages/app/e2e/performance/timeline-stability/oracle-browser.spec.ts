import { expect, test } from "@playwright/test"
import {
  analyzeVisualStability,
  startVisualStabilityProbe,
  stopVisualStabilityProbe,
} from "../../utils/visual-stability"
import { assistantMessage, setupTimeline, textPart, userMessage } from "./fixture"

test("detects blanking caused by ancestor opacity", async ({ page }) => {
  const partID = "prt_oracle_ancestor_opacity"
  await setupTimeline(page, { messages: [userMessage(), assistantMessage([textPart(partID, "Visible content")])] })
  const row = page.locator(`[data-timeline-part-id="${partID}"]`).first()
  await startVisualStabilityProbe(page, {
    content: { selector: `[data-timeline-part-id="${partID}"]` },
  })
  await row.evaluate((element) => {
    element.parentElement!.style.opacity = "0"
  })
  await page.waitForTimeout(50)
  await row.evaluate((element) => {
    element.parentElement!.style.opacity = "1"
  })
  await page.waitForTimeout(50)
  const issues = analyzeVisualStability(await stopVisualStabilityProbe(page))

  expect(issues.some((issue) => issue.includes("blanked between visible frames"))).toBe(true)
})

test("detects root opacity when probing descendant opacity", async ({ page }) => {
  const partID = "prt_oracle_descendant_opacity"
  await setupTimeline(page, { messages: [userMessage(), assistantMessage([textPart(partID, "Visible content")])] })
  const row = page.locator(`[data-timeline-part-id="${partID}"]`).first()
  await row.evaluate((element) => {
    element.innerHTML = '<span data-probe-opacity="true">Visible content</span>'
  })
  await startVisualStabilityProbe(page, {
    content: {
      selector: `[data-timeline-part-id="${partID}"]`,
      opacitySelectors: ['[data-probe-opacity="true"]'],
    },
  })
  await row.evaluate((element) => {
    ;(element as HTMLElement).style.opacity = "0"
  })
  await page.waitForTimeout(50)
  await row.evaluate((element) => {
    ;(element as HTMLElement).style.opacity = "1"
  })
  await page.waitForTimeout(50)
  const issues = analyzeVisualStability(await stopVisualStabilityProbe(page))

  expect(issues.some((issue) => issue.includes("blanked between visible frames"))).toBe(true)
})
