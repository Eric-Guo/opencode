import { expect, test } from "@playwright/test"
import {
  expectVisualStability,
  startVisualStabilityProbe,
  stopVisualStabilityProbe,
} from "../../utils/visual-stability"
import { assistantMessage, partUpdated, setupTimeline, shell, textPart, userMessage, type Message } from "./fixture"

test("does not reverse visible rows when the user wheels during shell remeasurement", async ({ page }, testInfo) => {
  const shellID = "prt_wheel_01_shell"
  const followingID = "prt_wheel_02_following"
  const timeline = await setupTimeline(page, {
    messages: [
      ...history(12),
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "Following wheel interaction")], {
        completed: false,
      }),
    ],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await startVisualStabilityProbe(page, {
    shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(partUpdated(shell(shellID, "running", lines(30))), 80)
  await scroller.evaluate((element) =>
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -180 })),
  )
  await scroller.evaluate((element) => (element.scrollTop -= 180))
  await timeline.send(partUpdated(shell(shellID, "running", lines(50))), 250)
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "wheel-during-resize", trace, {
    flow: ["shell", "following"],
    stable: ["shell", "following"],
    unique: ["shell", "following"],
    maxPositionReversals: 1,
  })
})

test("jump to latest lands on stable final rows after offscreen growth", async ({ page }, testInfo) => {
  const shellID = "prt_jump_01_shell"
  const followingID = "prt_jump_02_following"
  const timeline = await setupTimeline(page, {
    messages: [
      ...history(20),
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "Latest visible row")], { completed: false }),
    ],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await scroller.evaluate(
    (element) => (element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 600)),
  )
  await timeline.send(partUpdated(shell(shellID, "running", lines(50))), 300)
  await startVisualStabilityProbe(page, {
    shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await page.getByRole("button", { name: /Jump to latest/i }).click()
  await expect(page.locator(`[data-timeline-part-id="${followingID}"]`)).toBeVisible()
  await page.waitForTimeout(600)
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "jump-latest", trace, {
    flow: ["shell", "following"],
    unique: ["shell", "following"],
    acquireBottomAnchor: true,
    maxPositionReversals: 1,
  })
})

test("handles a single row taller than the viewport", async ({ page }, testInfo) => {
  const shellID = "prt_tall_01_shell"
  const followingID = "prt_tall_02_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "After tall row")], { completed: false }),
    ],
    settings: { shellToolPartsExpanded: true },
    viewport: { width: 900, height: 360 },
    cpuRate: 4,
    seedHistory: true,
  })
  await startVisualStabilityProbe(page, {
    shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(partUpdated(shell(shellID, "completed", lines(100))), 700)
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "taller-than-viewport", trace, {
    flow: ["shell", "following"],
    stable: ["shell", "following"],
    unique: ["shell", "following"],
    preserveBottomAnchor: true,
    maxPositionReversals: 0,
  })
})

function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const prefix = `msg_${String(index).padStart(4, "0")}_scroll`
    const userID = `${prefix}_a_user`
    return [
      userMessage(undefined, { id: userID, created: 1690000000000 + index * 10_000 }),
      assistantMessage(
        [textPart(`prt_${String(index).padStart(4, "0")}_scroll`, `History ${index}. ${"content ".repeat(30)}`)],
        {
          id: `${prefix}_b_assistant`,
          parentID: userID,
          created: 1690000001000 + index * 10_000,
        },
      ),
    ]
  }).flat()
}

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
