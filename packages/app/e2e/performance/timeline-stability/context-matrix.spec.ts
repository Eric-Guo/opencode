import { expect, test } from "@playwright/test"
import {
  expectVisualStability,
  startVisualStabilityProbe,
  stopVisualStabilityProbe,
} from "../../utils/visual-stability"
import {
  assistantID,
  assistantMessage,
  event,
  partUpdated,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
  waitForVisualSettle,
} from "./fixture"

const inputs = {
  read: { filePath: "src/a.ts", offset: 0, limit: 120 },
  glob: { path: ".", pattern: "**/*.ts" },
  grep: { path: ".", pattern: "stable", include: "*.ts" },
  list: { path: "src" },
}

test("appends context operations while the group is expanded", async ({ page }, testInfo) => {
  const firstID = "prt_append_01_read"
  const followingID = "prt_append_99_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([toolPart(firstID, "read", "running", inputs.read), textPart(followingID, "Following append")], {
        completed: false,
      }),
    ],
    cpuRate: 4,
  })
  const initialGroup = `[data-timeline-part-ids="${firstID}"]`
  await page.locator(`${initialGroup} [data-slot="collapsible-trigger"]`).click()
  await waitForVisualSettle(page, [initialGroup, `[data-timeline-part-id="${followingID}"]`])
  await startVisualStabilityProbe(page, {
    context: {
      selector: '[data-timeline-part-ids^="prt_append_01_read"]',
      closest: '[data-timeline-row="AssistantPart"]',
    },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(partUpdated(toolPart("prt_append_02_glob", "glob", "running", inputs.glob)), 180)
  await timeline.send(partUpdated(toolPart("prt_append_03_grep", "grep", "completed", inputs.grep)), 240)
  await timeline.send(partUpdated(toolPart("prt_append_04_list", "list", "completed", inputs.list)), 500)
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "context-append", trace, {
    flow: ["context", "following"],
    stable: ["context", "following"],
    unique: ["context", "following"],
    preserveBottomAnchor: true,
    maxPositionReversals: 0,
    motion: ["following"],
    perMarker: true,
  })
  await expect(
    page.locator(
      '[data-timeline-part-ids="prt_append_01_read,prt_append_02_glob,prt_append_03_grep,prt_append_04_list"]',
    ),
  ).toBeVisible()
  await expect(
    page.locator('[data-timeline-part-ids^="prt_append_01_read"] [data-slot="collapsible-trigger"]'),
  ).toHaveAttribute("aria-expanded", "true")
})

test("splits and merges context groups when a middle text part changes", async ({ page }, testInfo) => {
  const textID = "prt_split_02_text"
  const followingID = "prt_split_99_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart("prt_split_01_read", "read", "completed", inputs.read),
        textPart(textID, "Boundary"),
        toolPart("prt_split_03_glob", "glob", "completed", inputs.glob),
        textPart(followingID, "Following split groups"),
      ]),
    ],
    cpuRate: 4,
  })
  await startVisualStabilityProbe(page, {
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(
    event("message.part.removed", { sessionID: "ses_timeline_stability", messageID: assistantID, partID: textID }),
    500,
  )
  await expect(page.locator('[data-timeline-part-ids="prt_split_01_read,prt_split_03_glob"]')).toBeVisible()
  await timeline.send(partUpdated(textPart(textID, "Boundary restored")), 500)
  await expect(page.locator('[data-timeline-part-ids="prt_split_01_read"]')).toBeVisible()
  await expect(page.locator('[data-timeline-part-ids="prt_split_03_glob"]')).toBeVisible()
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "context-split-merge", trace, {
    stable: ["following"],
    unique: ["following"],
    maxPositionReversals: 1,
    perMarker: true,
  })
})

test("removing the first context member replaces the group once without overlapping following content", async ({
  page,
}, testInfo) => {
  const ids = ["prt_key_01_read", "prt_key_02_glob", "prt_key_03_grep"]
  const followingID = "prt_key_99_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(ids[0]!, "read", "completed", inputs.read),
        toolPart(ids[1]!, "glob", "completed", inputs.glob),
        toolPart(ids[2]!, "grep", "completed", inputs.grep),
        textPart(followingID, "Following replaced group"),
      ]),
    ],
    cpuRate: 4,
  })
  const original = page.locator(`[data-timeline-part-ids="${ids.join(",")}"]`)
  const originalRowKey = await original.evaluate((element) =>
    element.closest("[data-timeline-key]")?.getAttribute("data-timeline-key"),
  )
  await original.locator('[data-slot="collapsible-trigger"]').click()
  await expect(original.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
  await startVisualStabilityProbe(page, {
    context: {
      selector: '[data-timeline-part-ids*="prt_key_02_glob"]',
      closest: '[data-timeline-row="AssistantPart"]',
    },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(
    event("message.part.removed", { sessionID: "ses_timeline_stability", messageID: assistantID, partID: ids[0] }),
    500,
  )
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "context-first-remove", trace, {
    flow: ["context", "following"],
    unique: ["context", "following"],
    maxPositionReversals: 0,
  })
  await expect(page.locator(`[data-timeline-part-ids="${ids.slice(1).join(",")}"]`)).toBeVisible()
  expect(
    await page
      .locator(`[data-timeline-part-ids="${ids.slice(1).join(",")}"]`)
      .evaluate((element) => element.closest("[data-timeline-key]")?.getAttribute("data-timeline-key")),
  ).toBe(originalRowKey)
  await expect(
    page.locator(`[data-timeline-part-ids="${ids.slice(1).join(",")}"] [data-slot="collapsible-trigger"]`),
  ).toHaveAttribute("aria-expanded", "true")
})

test("preserves a collapsed context group through count and status updates", async ({ page }) => {
  const ids = ["prt_closed_01_read", "prt_closed_02_glob"]
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [toolPart(ids[0]!, "read", "running", inputs.read), toolPart(ids[1]!, "glob", "running", inputs.glob)],
        { completed: false },
      ),
    ],
  })
  const group = page.locator(`[data-timeline-part-ids="${ids.join(",")}"]`)
  const trigger = group.locator('[data-slot="collapsible-trigger"]')
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.send(partUpdated(toolPart(ids[0]!, "read", "completed", inputs.read)), 100)
  await timeline.send(partUpdated(toolPart(ids[1]!, "glob", "completed", inputs.glob)), 300)
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})
