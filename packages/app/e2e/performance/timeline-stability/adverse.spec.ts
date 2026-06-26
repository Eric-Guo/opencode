import { expect, test } from "@playwright/test"
import {
  expectVisualStability,
  startVisualStabilityProbe,
  stopVisualStabilityProbe,
} from "../../utils/visual-stability"
import {
  assistantMessage,
  partUpdated,
  setupTimeline,
  shell,
  textPart,
  toolPart,
  userMessage,
  waitForVisualSettle,
  type Message,
} from "./fixture"

test.describe("timeline adverse visual stability", () => {
  test("does not pull a scrolled-away user while an active shell grows", async ({ page }, testInfo) => {
    const activeShellID = "prt_adverse_01_shell"
    const messages = [
      ...history(24),
      userMessage(),
      assistantMessage([shell(activeShellID, "running")], { completed: false }),
    ]
    const timeline = await setupTimeline(page, {
      messages,
      settings: { shellToolPartsExpanded: true },
      cpuRate: 4,
      eventRetry: 30,
    })
    const scroller = page.locator(".scroll-view__viewport", {
      has: page.locator('[data-timeline-row="AssistantPart"]'),
    })
    await scroller.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 450)
    })
    await page.waitForTimeout(150)
    const anchor = await scroller.evaluate((element) => {
      const view = element.getBoundingClientRect()
      return [...element.querySelectorAll<HTMLElement>("[data-timeline-key]")].find((row) => {
        const rect = row.getBoundingClientRect()
        return rect.top >= view.top + 40 && rect.bottom <= view.bottom - 40
      })?.dataset.timelineKey
    })
    expect(anchor).toBeTruthy()
    await waitForVisualSettle(page, [`[data-timeline-key="${anchor}"]`])

    await startVisualStabilityProbe(page, {
      anchor: { selector: `[data-timeline-key="${anchor}"]` },
    })
    await timeline.send(partUpdated(shell(activeShellID, "running", lines(1))), 180)
    await timeline.send(partUpdated(shell(activeShellID, "running", lines(10))), 90)
    await timeline.send(partUpdated(shell(activeShellID, "running", lines(50))), 350)
    await timeline.send(partUpdated(shell(activeShellID, "completed", lines(50))), 500)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "scrolled-away-shell", trace, {
      stable: ["anchor"],
      fixed: ["anchor"],
      unique: ["anchor"],
      maxPositionReversals: 0,
    })
  })

  test("preserves an explicit shell state across virtualization", async ({ page }) => {
    const targetID = "prt_virtual_shell"
    const messages = [
      userMessage(undefined, { id: "msg_0000_virtual_user", created: 1700000000000 }),
      assistantMessage([shell(targetID, "completed", lines(20))], {
        id: "msg_0001_virtual_assistant",
        parentID: "msg_0000_virtual_user",
        created: 1700000001000,
      }),
      ...history(35, 10),
    ]
    await setupTimeline(page, { messages, settings: { shellToolPartsExpanded: false } })
    const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1_000 }))
      element.scrollTop = 0
    })
    await page.waitForTimeout(300)
    const trigger = page.locator(`[data-timeline-part-id="${targetID}"] [data-slot="collapsible-trigger"]`)
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")

    await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
    await expect(page.locator(`[data-timeline-part-id="${targetID}"]`)).toHaveCount(0)
    await scroller.evaluate((element) => (element.scrollTop = 0))
    await expect(trigger).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  test("keeps narrow viewport rows ordered during long shell growth", async ({ page }, testInfo) => {
    const shellID = "prt_narrow_01_shell"
    const followingID = "prt_narrow_02_following"
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          [shell(shellID, "running"), textPart(followingID, "A narrow following row that wraps across lines.")],
          {
            completed: false,
          },
        ),
      ],
      settings: { shellToolPartsExpanded: true },
      viewport: { width: 430, height: 800 },
      cpuRate: 4,
    })
    await waitForVisualSettle(page, [
      `[data-timeline-part-id="${shellID}"]`,
      `[data-timeline-part-id="${followingID}"]`,
    ])
    await startVisualStabilityProbe(page, {
      shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: `[data-timeline-part-id="${followingID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    await timeline.send(partUpdated(shell(shellID, "running", wideLines(10))), 100)
    await timeline.send(partUpdated(shell(shellID, "running", wideLines(50))), 300)
    await timeline.send(partUpdated(shell(shellID, "completed", wideLines(50))), 500)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "narrow-shell", trace, {
      flow: ["shell", "following"],
      stable: ["shell", "following"],
      unique: ["shell", "following"],
      preserveBottomAnchor: true,
      maxPositionReversals: 0,
      perMarker: true,
    })
  })

  test("keeps visible rows ordered while resizing desktop to narrow and back", async ({ page }, testInfo) => {
    const shellID = "prt_resize_01_shell"
    const contextIDs = ["prt_resize_02_read", "prt_resize_03_glob"]
    const followingID = "prt_resize_04_following"
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([
          shell(shellID, "completed", wideLines(15)),
          toolPart(contextIDs[0]!, "read", "completed", { filePath: "src/a.ts" }),
          toolPart(contextIDs[1]!, "glob", "completed", { path: ".", pattern: "**/*.ts" }),
          textPart(followingID, "Following responsive timeline content that wraps on narrow screens."),
        ]),
      ],
      settings: { shellToolPartsExpanded: true },
      cpuRate: 4,
      seedHistory: true,
    })
    const group = `[data-timeline-part-ids="${contextIDs.join(",")}"]`
    await startVisualStabilityProbe(page, {
      shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
      context: { selector: group, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: `[data-timeline-part-id="${followingID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    await page.setViewportSize({ width: 430, height: 800 })
    await page.waitForTimeout(500)
    await page.setViewportSize({ width: 900, height: 800 })
    await page.waitForTimeout(500)
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.waitForTimeout(500)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "responsive-resize", trace, {
      flow: ["shell", "context", "following"],
      stable: ["shell", "context", "following"],
      unique: ["shell", "context", "following"],
      maxPositionReversals: 4,
      maxReversals: 4,
    })
  })
})

function history(count: number, offset = 0): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const value = index + offset
    const prefix = `msg_0${String(value).padStart(3, "0")}_history`
    const userID = `${prefix}_a_user`
    return [
      userMessage(undefined, { id: userID, created: 1699990000000 + value * 10_000 }),
      assistantMessage(
        [
          textPart(
            `prt_history_${String(value).padStart(3, "0")}`,
            `Historical response ${value}. ${"Stable history content. ".repeat(8)}`,
          ),
        ],
        {
          id: `${prefix}_b_assistant`,
          parentID: userID,
          created: 1699990001000 + value * 10_000,
        },
      ),
    ]
  }).flat()
}

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}

function wideLines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1} ${"wide-output-".repeat(20)}`).join("\n")
}
