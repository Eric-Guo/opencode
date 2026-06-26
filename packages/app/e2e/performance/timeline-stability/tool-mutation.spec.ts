import { expect, test } from "@playwright/test"
import {
  expectVisualStability,
  startVisualStabilityProbe,
  stopVisualStabilityProbe,
} from "../../utils/visual-stability"
import {
  assistantMessage,
  partUpdated,
  session,
  sessionID,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
} from "./fixture"

test("adds a task child-session link without replacing the task row", async ({ page }, testInfo) => {
  const taskID = "prt_task_link"
  const childID = "ses_task_child"
  const input = { description: "Inspect child", subagent_type: "explore" }
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([toolPart(taskID, "task", "running", input)], { completed: false })],
    sessions: [session(), session({ id: childID, parentID: sessionID, title: "Inspect child" })],
    cpuRate: 4,
  })
  await startVisualStabilityProbe(page, {
    task: { selector: `[data-timeline-part-id="${taskID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(
    partUpdated(toolPart(taskID, "task", "completed", input, { metadata: { sessionId: childID } })),
    500,
  )
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "task-link", trace, {
    stable: ["task"],
    unique: ["task"],
    maxPositionReversals: 0,
  })
  await expect(
    page.locator(`a[href$="/session/${childID}"]`, { has: page.locator('[data-component="task-tool-card"]') }),
  ).toBeVisible()
})

test("updates expanded web search links without resetting expansion", async ({ page }) => {
  const searchID = "prt_websearch_mutation"
  const input = { query: "timeline stability" }
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([toolPart(searchID, "websearch", "completed", input, { output: "https://example.com/one" })]),
    ],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${searchID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]')
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await timeline.send(
    partUpdated(
      toolPart(searchID, "websearch", "completed", input, {
        output: "https://example.com/one\nhttps://example.com/two",
      }),
    ),
    300,
  )
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(wrapper.locator('a[href="https://example.com/two"]')).toBeVisible()
})

test("preserves an expanded tool error card across duplicate delivery", async ({ page }) => {
  const toolID = "prt_duplicate_error"
  const failed = toolPart(toolID, "bash", "error", { command: "exit 1" }, { error: "Command failed visibly" })
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistantMessage([failed])] })
  const wrapper = page.locator(`[data-timeline-part-id="${toolID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]')
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await timeline.send(partUpdated(failed), 150)
  await timeline.send(partUpdated(failed), 250)
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(wrapper).toContainText("Command failed visibly")
})

test("renders multiple question answers and preserves open state on answer updates", async ({ page }) => {
  const questionID = "prt_multi_question"
  const input = {
    questions: [
      { header: "First", question: "First choice?", options: [] },
      { header: "Second", question: "Second choice?", options: [], multiple: true },
    ],
  }
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(questionID, "question", "completed", input, { metadata: { answers: [["A"], ["B", "C"]] } }),
      ]),
    ],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${questionID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]')
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await timeline.send(
    partUpdated(
      toolPart(questionID, "question", "completed", input, { metadata: { answers: [["Updated"], ["B", "C"]] } }),
    ),
    300,
  )
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(wrapper).toContainText("Updated")
  await expect(wrapper).toContainText("B, C")
})

test("changes generic tool arguments without replacing the row", async ({ page }, testInfo) => {
  const toolID = "prt_generic_mutation"
  const followingID = "prt_generic_mutation_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(toolID, "mcp_probe", "running", { target: "one", count: 1 }),
          textPart(followingID, "Following generic tool"),
        ],
        { completed: false },
      ),
    ],
    cpuRate: 4,
  })
  await startVisualStabilityProbe(page, {
    tool: { selector: `[data-timeline-part-id="${toolID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(
    partUpdated(toolPart(toolID, "mcp_probe", "running", { target: "two", count: 2, mode: "deep" })),
    200,
  )
  await timeline.send(
    partUpdated(toolPart(toolID, "mcp_probe", "completed", { target: "two", count: 2, mode: "deep" })),
    400,
  )
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "generic-mutation", trace, {
    flow: ["tool", "following"],
    stable: ["tool", "following"],
    unique: ["tool", "following"],
    maxPositionReversals: 0,
    perMarker: true,
  })
})
