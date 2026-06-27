import { expect, test } from "@playwright/test"
import {
  expectVisualStability,
  startVisualStabilityProbe,
  stopVisualStabilityProbe,
} from "../../utils/visual-stability"
import {
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partDelta,
  partUpdated,
  reasoningPart,
  setupTimeline,
  shell,
  status,
  textPart,
  userMessage,
  waitForVisualSettle,
} from "./fixture"

test.describe("timeline visual lifecycle stability", () => {
  test("streams empty, short, and long parallel shells to staggered completion", async ({ page }, testInfo) => {
    test.setTimeout(180_000)
    const ids = Array.from({ length: 5 }, (_, index) => `prt_shell_${index + 1}`)
    const initial = ids.map((id) => shell(id, "running"))
    const followingID = "prt_shell_following"
    const assistant = assistantMessage([...initial, textPart(followingID, "Following all parallel shells.")], {
      completed: false,
    })
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistant],
      settings: { shellToolPartsExpanded: true, showReasoningSummaries: true },
      cpuRate: 4,
      eventRetry: 24,
    })
    await timeline.send(status("busy"), 150)
    for (const id of ids) await timeline.waitForPart(id)
    const scroller = page.locator(".scroll-view__viewport", {
      has: page.locator('[data-timeline-row="AssistantPart"]'),
    })
    await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
    await waitForVisualSettle(page, [
      ...ids.map((id) => `[data-timeline-part-id="${id}"]`),
      `[data-timeline-part-id="${followingID}"]`,
    ])

    const regions = Object.fromEntries([
      ...ids.map((id) => [
        id,
        { selector: `[data-timeline-part-id="${id}"]`, closest: '[data-timeline-row="AssistantPart"]' },
      ]),
      [
        "following",
        { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
      ],
    ])
    await startVisualStabilityProbe(page, regions)
    await timeline.sendAll([
      { event: partUpdated(shell(ids[2]!, "running", lines(2))), delay: 90 },
      { event: partUpdated(shell(ids[0]!, "completed", "")), delay: 180 },
      { event: partUpdated(shell(ids[4]!, "running", lines(10))), delay: 70 },
      { event: partUpdated(shell(ids[2]!, "completed", lines(2))), delay: 260 },
      { event: partUpdated(shell(ids[1]!, "running", "one line")), delay: 110 },
      { event: partUpdated(shell(ids[4]!, "running", lines(25))), delay: 80 },
      { event: partUpdated(shell(ids[1]!, "completed", "one line")), delay: 320 },
      { event: partUpdated(shell(ids[3]!, "completed", lines(5))), delay: 120 },
      { event: partUpdated(shell(ids[4]!, "running", lines(50))), delay: 100 },
      { event: partUpdated(shell(ids[4]!, "completed", lines(50))), delay: 450 },
      { event: messageUpdated(completedAssistantInfo(assistant.info)), delay: 100 },
      { event: status("idle"), delay: 700 },
    ])
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "parallel-shells", trace, {
      flow: [...ids, "following"],
      stable: [...ids, "following"],
      unique: ids,
      preserveBottomAnchor: true,
      maxPositionReversals: 0,
      maxReversals: 4,
      perMarker: true,
    })
    await expect(page.locator(`[data-timeline-part-id="${ids[4]}"] [data-slot="bash-pre"]`)).toContainText("line 50")

    const third = page.locator(`[data-timeline-part-id="${ids[2]}"]`)
    await third.locator('[data-slot="collapsible-trigger"]').click()
    await expect(third.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
    await timeline.send(partUpdated(textPart("prt_late_sibling", "A later sibling rerender.")), 250)
    await expect(third.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
  })

  for (const expanded of [false, true]) {
    test(`preserves shell user intent from a ${expanded ? "expanded" : "collapsed"} default`, async ({ page }) => {
      const id = `prt_shell_default_${expanded}`
      const timeline = await setupTimeline(page, {
        messages: [userMessage(), assistantMessage([shell(id, "completed", lines(3))])],
        settings: { shellToolPartsExpanded: expanded },
      })
      const trigger = page.locator(`[data-timeline-part-id="${id}"] [data-slot="collapsible-trigger"]`)
      await expect(trigger).toHaveAttribute("aria-expanded", String(expanded))
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))

      await timeline.send(partUpdated(shell(id, "completed", lines(6))), 180)
      await timeline.send(partUpdated(textPart(`prt_sibling_${expanded}`, "Sibling content")), 180)
      await timeline.send(status("busy"), 100)
      await timeline.send(status("idle"), 250)
      await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))
    })
  }

  test("transitions thinking and hidden reasoning through busy to idle", async ({ page }) => {
    const reasoningID = "prt_reasoning_hidden"
    const assistant = assistantMessage([reasoningPart(reasoningID, "## Inspecting stability")], { completed: false })
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistant],
      settings: { showReasoningSummaries: false },
      cpuRate: 4,
    })
    await timeline.send(status("busy"), 150)

    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
    await expect(page.getByText("Inspecting stability", { exact: true })).toBeVisible()
    await expect(page.locator(`[data-timeline-part-id="${reasoningID}"]`)).toHaveCount(0)
    await timeline.send(partUpdated(shell("prt_reasoning_shell", "running")), 160)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
    await timeline.send(partUpdated(shell("prt_reasoning_shell", "completed", "done")), 180)
    await timeline.send(messageUpdated(completedAssistantInfo(assistant.info)), 100)
    await timeline.send(status("idle"), 300)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await expect(page.locator(`[data-timeline-part-id="${reasoningID}"]`)).toHaveCount(0)
  })

  test("replaces thinking with streamed reasoning and text without a blank visible turn", async ({
    page,
  }, testInfo) => {
    const reasoningID = "prt_reasoning_visible"
    const textID = "prt_streamed_text"
    const assistant = assistantMessage([], { completed: false })
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistant],
      settings: { showReasoningSummaries: true },
      cpuRate: 4,
    })
    await timeline.send(status("busy"), 120)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()

    await startVisualStabilityProbe(page, {
      thinking: { selector: '[data-timeline-row="Thinking"]' },
      reasoning: {
        selector: `[data-timeline-part-id="${reasoningID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
      text: { selector: `[data-timeline-part-id="${textID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    })
    await timeline.send(partUpdated(reasoningPart(reasoningID, "")), 100)
    await expect(page.locator(`[data-timeline-part-id="${reasoningID}"]`)).toHaveCount(0)
    await timeline.send(partUpdated(reasoningPart(reasoningID, "## Planning\n\nChecking the visible timeline.")), 160)
    await timeline.waitForPart(reasoningID)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await timeline.send(partUpdated(textPart(textID, "Starting")), 100)
    await timeline.send(partDelta(textID, " **stable"), 90)
    await timeline.send(partDelta(textID, " output** with `code` and [a link"), 130)
    await timeline.send(partDelta(textID, "](https://example.com)."), 220)
    await timeline.send(messageUpdated(completedAssistantInfo(assistant.info)), 120)
    await timeline.send(status("idle"), 500)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "reasoning-text-handoff", trace, {
      flow: ["reasoning", "text"],
      stable: ["reasoning", "text"],
      unique: ["reasoning", "text"],
      maxReversals: 4,
      continuousAny: [["thinking", "reasoning", "text"]],
    })
    await expect(page.locator(`[data-timeline-part-id="${textID}"]`)).toContainText("stable output")
  })

  test("moves busy through retry and recovery to final idle content", async ({ page }) => {
    const assistant = assistantMessage([], { completed: false })
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(undefined, {
          summary: {
            diffs: [
              {
                file: "src/retry.ts",
                additions: 1,
                deletions: 1,
                patch: "@@ -1 +1 @@\n-export const retry = false\n+export const retry = true",
                before: "export const retry = false\n",
                after: "export const retry = true\n",
              },
            ],
          },
        }),
        assistant,
      ],
    })
    await timeline.send(status("busy"), 140)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
    await expect(page.locator('[data-timeline-row="DiffSummary"]')).toHaveCount(0)
    await timeline.send(status("retry"), 180)
    await expect(page.locator('[data-timeline-row="Retry"]')).toBeVisible()
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await timeline.send(status("busy", 2), 180)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
    await timeline.send(partUpdated(textPart("prt_recovered", "Recovered response")), 140)
    await timeline.send(messageUpdated(completedAssistantInfo(assistant.info)), 100)
    await timeline.send(status("idle"), 350)
    await expect(page.locator('[data-timeline-row="Retry"]')).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="DiffSummary"]')).toBeVisible()
  })
})

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
