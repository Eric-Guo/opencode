import { expect, test } from "@playwright/test"
import {
  expectVisualStability,
  startVisualStabilityProbe,
  stopVisualStabilityProbe,
} from "../../utils/visual-stability"
import {
  assistantMessage,
  directory,
  partUpdated,
  session,
  sessionID,
  setupTimeline,
  status,
  textPart,
  toolPart,
  userMessage,
} from "./fixture"

test.describe("timeline tool state stability", () => {
  test("moves lightweight tools through pending, running, and completed without replacing rows", async ({
    page,
  }, testInfo) => {
    const ids = ["webfetch", "websearch", "task", "skill", "custom"] as const
    const inputs = {
      webfetch: { url: "https://example.com/docs" },
      websearch: { query: "timeline stability" },
      task: { description: "Inspect timeline", subagent_type: "explore" },
      skill: { name: "stability" },
      custom: { target: "timeline", depth: 2 },
    }
    const names = { webfetch: "webfetch", websearch: "websearch", task: "task", skill: "skill", custom: "mcp_probe" }
    const questionID = "prt_state_question"
    const todoID = "prt_state_todo"
    const initial = [
      ...ids.map((id) => toolPart(`prt_state_${id}`, names[id], "pending", inputs[id])),
      toolPart(questionID, "question", "pending", questionInput()),
      toolPart(todoID, "todowrite", "pending", { todos: [{ content: "Hidden", status: "pending" }] }),
      textPart("prt_state_following", "Following lightweight tools"),
    ]
    const childID = "ses_timeline_child"
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage(initial, { completed: false })],
      sessions: [session(), session({ id: childID, parentID: sessionID, title: "Inspect timeline" })],
      cpuRate: 4,
    })
    await timeline.send(status("busy"), 120)
    for (const id of ids) await timeline.waitForPart(`prt_state_${id}`)
    await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-timeline-part-id="${todoID}"]`)).toHaveCount(0)

    const regionIDs = ids.map((id) => `prt_state_${id}`)
    await startVisualStabilityProbe(
      page,
      Object.fromEntries(
        regionIDs.map((id) => [
          id,
          { selector: `[data-timeline-part-id="${id}"]`, closest: '[data-timeline-row="AssistantPart"]' },
        ]),
      ),
    )
    for (const [index, id] of ids.entries()) {
      await timeline.send(
        partUpdated(toolPart(`prt_state_${id}`, names[id], "running", inputs[id])),
        [80, 240, 100, 360, 140][index],
      )
    }
    for (const [index, id] of ["skill", "webfetch", "custom", "task", "websearch"].entries()) {
      const key = id as (typeof ids)[number]
      const metadata = key === "task" ? { sessionId: childID } : key === "websearch" ? { provider: "exa" } : {}
      const output = key === "websearch" ? "Result https://example.com/result" : "Completed"
      await timeline.send(
        partUpdated(toolPart(`prt_state_${key}`, names[key], "completed", inputs[key], { metadata, output })),
        [110, 70, 280, 130, 420][index],
      )
    }
    await timeline.send(
      partUpdated(
        toolPart(questionID, "question", "completed", questionInput(), { metadata: { answers: [["Keep it stable"]] } }),
      ),
      350,
    )
    await timeline.waitForPart(questionID)
    await timeline.send(status("idle"), 500)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "lightweight-tools", trace, {
      stable: regionIDs,
      unique: regionIDs,
      maxReversals: 4,
    })
    await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toContainText("Keep it stable")
    await expect(page.locator(`[data-timeline-part-id="${todoID}"]`)).toHaveCount(0)
    await expect(
      page.locator(`a[href$="/session/${childID}"]`, { has: page.locator('[data-component="task-tool-card"]') }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: /Exa Web Search/ })).toBeVisible()
  })

  test("stabilizes edit, write, and multi-file patch completion while expanded", async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    const ids = ["prt_file_01_edit", "prt_file_02_write", "prt_file_03_patch"]
    const pending = [
      toolPart(ids[0]!, "edit", "pending", { filePath: "src/edit.ts" }),
      toolPart(ids[1]!, "write", "pending", { filePath: "src/write.ts", content: source(40) }),
      toolPart(ids[2]!, "apply_patch", "pending", { files: ["src/a.ts", "src/b.ts", "src/old.ts"] }),
      textPart("prt_file_04_following", "Following file operations"),
    ]
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage(pending, { completed: false })],
      settings: { editToolPartsExpanded: true },
      cpuRate: 4,
    })
    for (const id of ids) await timeline.waitForPart(id)
    const regions = Object.fromEntries([
      ...ids.map((id) => [
        id,
        { selector: `[data-timeline-part-id="${id}"]`, closest: '[data-timeline-row="AssistantPart"]' },
      ]),
      [
        "following",
        { selector: '[data-timeline-part-id="prt_file_04_following"]', closest: '[data-timeline-row="AssistantPart"]' },
      ],
    ])
    await startVisualStabilityProbe(page, regions)
    await timeline.send(partUpdated(edit("running")), 180)
    await timeline.send(partUpdated(write("running")), 90)
    await timeline.send(partUpdated(patch("running")), 300)
    await timeline.send(partUpdated(write("completed")), 140)
    await timeline.send(partUpdated(edit("completed")), 380)
    await timeline.send(partUpdated(patch("completed")), 800)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "file-tools", trace, {
      flow: [...ids, "following"],
      stable: ids,
      unique: ids,
      preserveBottomAnchor: true,
      maxPositionReversals: 0,
      maxReversals: 4,
    })
    await expect(page.locator('[data-component="edit-content"]')).toBeVisible()
    await expect(page.locator('[data-component="write-content"]')).toBeVisible()
    await expect(page.locator('[data-component="apply-patch-file-diff"]')).toHaveCount(2)
    await expect(
      page.locator('[data-scope="apply-patch"] [data-type="delete"] [data-slot="collapsible-content"]'),
    ).toBeHidden()
  })

  test("keeps an expanded mixed context group stable through staggered completion and error", async ({
    page,
  }, testInfo) => {
    const ids = ["prt_ctx_01_read", "prt_ctx_02_glob", "prt_ctx_03_grep", "prt_ctx_04_list"]
    const tools = ["read", "glob", "grep", "list"]
    const inputs = [
      { filePath: "src/a.ts", offset: 0, limit: 120 },
      { path: directory, pattern: "**/*.ts" },
      { path: directory, pattern: "stability", include: "*.ts" },
      { path: "src" },
    ]
    const context = ids.map((id, index) => toolPart(id, tools[index]!, "pending", inputs[index]!))
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([...context, textPart("prt_ctx_following", "Following context")], { completed: false }),
      ],
      cpuRate: 4,
    })
    await timeline.send(status("busy"), 100)
    const groupSelector = `[data-timeline-part-ids="${ids.join(",")}"]`
    const group = page.locator(groupSelector)
    await expect(group).toBeVisible()
    await group.locator('[data-slot="collapsible-trigger"]').click()
    await expect(group.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")

    await startVisualStabilityProbe(page, {
      status: {
        selector: `${groupSelector} [data-component="tool-status-title"]`,
        opacitySelectors: ['[data-slot="tool-status-active"]', '[data-slot="tool-status-done"]'],
      },
      context: { selector: groupSelector, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: '[data-timeline-part-id="prt_ctx_following"]',
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    for (const [index, delay] of [90, 260, 70, 380].entries()) {
      await timeline.send(partUpdated(toolPart(ids[index]!, tools[index]!, "running", inputs[index]!)), delay)
    }
    await timeline.send(partUpdated(toolPart(ids[1]!, tools[1]!, "completed", inputs[1]!)), 130)
    await timeline.send(partUpdated(toolPart(ids[3]!, tools[3]!, "completed", inputs[3]!)), 210)
    await timeline.send(
      partUpdated(toolPart(ids[0]!, tools[0]!, "error", inputs[0]!, { error: "Read interrupted" })),
      110,
    )
    await timeline.send(partUpdated(toolPart(ids[2]!, tools[2]!, "completed", inputs[2]!)), 250)
    await expect(group.locator('[data-component="tool-status-title"]')).toHaveAttribute("aria-label", "Explored")
    await timeline.send(status("idle"), 700)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, "mixed-context", trace, {
      flow: ["context", "following"],
      stable: ["context"],
      unique: ["context"],
      maxReversals: 4,
    })
    await expect(group.locator('[data-component="tool-status-title"]')).toHaveAttribute("aria-label", "Explored")
    await expect(group.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
    await group.locator('[data-slot="collapsible-trigger"]').click()
    await expect(group.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
    await timeline.send(partUpdated(textPart("prt_ctx_late_sibling", "Later sibling content")), 200)
    await expect(group.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
    await group.locator('[data-slot="collapsible-trigger"]').click()
    await expect(group.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
  })

  test("renders every tool error outcome without leaking hidden tools", async ({ page }) => {
    const ordinary = ["bash", "edit", "write", "apply_patch", "webfetch", "websearch", "task", "skill", "mcp_probe"]
    const parts = ordinary.map((tool, index) =>
      toolPart(`prt_error_${index}`, tool, "error", errorInput(tool), { error: `${tool} failed visibly` }),
    )
    parts.push(
      toolPart("prt_question_dismissed", "question", "error", questionInput(), {
        error: "The user dismissed this question",
      }),
      toolPart("prt_question_error", "question", "error", questionInput(), { error: "Question transport failed" }),
      toolPart("prt_todo_error", "todowrite", "error", { todos: [] }, { error: "Hidden todo failure" }),
    )
    await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

    await expect(page.locator('[data-kind="tool-error-card"]')).toHaveCount(ordinary.length + 1)
    await expect(page.getByText(/dismissed/i)).toBeVisible()
    await expect(page.locator('[data-timeline-part-id="prt_todo_error"]')).toHaveCount(0)
    for (let index = 0; index < ordinary.length; index++) {
      await expect(page.locator(`[data-timeline-part-id="prt_error_${index}"]`)).toBeVisible()
    }
  })

  test("transitions shell and question through running error outcomes", async ({ page }) => {
    const shellID = "prt_transition_error_shell"
    const questionID = "prt_transition_error_question"
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          [
            toolPart(shellID, "bash", "pending", { command: "exit 1" }),
            toolPart(questionID, "question", "pending", questionInput()),
          ],
          { completed: false },
        ),
      ],
    })
    await timeline.waitForPart(shellID)
    await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
    await timeline.send(partUpdated(toolPart(shellID, "bash", "running", { command: "exit 1" })), 120)
    await timeline.send(partUpdated(toolPart(questionID, "question", "running", questionInput())), 180)
    await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
    await timeline.send(
      partUpdated(toolPart(shellID, "bash", "error", { command: "exit 1" }, { error: "Command exited 1" })),
      180,
    )
    await timeline.send(
      partUpdated(
        toolPart(questionID, "question", "error", questionInput(), { error: "The user dismissed this question" }),
      ),
      250,
    )

    await expect(page.locator(`[data-timeline-part-id="${shellID}"] [data-kind="tool-error-card"]`)).toBeVisible()
    await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toContainText(/dismissed/i)
  })

  test("labels all web search provider variants", async ({ page }) => {
    const parts = [
      toolPart(
        "prt_search_parallel",
        "websearch",
        "completed",
        { query: "parallel" },
        { metadata: { provider: "parallel" } },
      ),
      toolPart("prt_search_exa", "websearch", "completed", { query: "exa" }, { metadata: { provider: "exa" } }),
      toolPart("prt_search_generic", "websearch", "completed", { query: "generic" }),
    ]
    await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

    await expect(page.getByRole("button", { name: /Parallel Web Search/ })).toBeVisible()
    await expect(page.getByRole("button", { name: /Exa Web Search/ })).toBeVisible()
    await expect(page.getByRole("button", { name: /^Web Search/ })).toBeVisible()
  })
})

function questionInput() {
  return { questions: [{ header: "Stability", question: "Keep it stable?", options: [] }] }
}

function edit(state: "running" | "completed") {
  return toolPart(
    "prt_file_01_edit",
    "edit",
    state,
    { filePath: "src/edit.ts" },
    {
      metadata:
        state === "completed"
          ? {
              filediff: {
                file: "src/edit.ts",
                additions: 2,
                deletions: 1,
                before: source(30),
                after: source(31),
              },
            }
          : {},
    },
  )
}

function write(state: "running" | "completed") {
  return toolPart("prt_file_02_write", "write", state, { filePath: "src/write.ts", content: source(40) })
}

function patch(state: "running" | "completed") {
  return toolPart(
    "prt_file_03_patch",
    "apply_patch",
    state,
    { files: ["src/a.ts", "src/b.ts", "src/old.ts"] },
    {
      metadata:
        state === "completed"
          ? {
              files: [patchFile("src/a.ts", "update"), patchFile("src/b.ts", "add"), patchFile("src/old.ts", "delete")],
            }
          : {},
    },
  )
}

function patchFile(filePath: string, type: "add" | "update" | "delete") {
  return {
    filePath,
    relativePath: filePath,
    type,
    additions: type === "delete" ? 0 : 1,
    deletions: type === "add" ? 0 : 1,
    before: type === "add" ? undefined : source(8),
    after: type === "delete" ? undefined : source(9),
  }
}

function source(count: number) {
  return Array.from({ length: count }, (_, index) => `export const value${index} = ${index}\n`).join("")
}

function errorInput(tool: string) {
  if (tool === "bash") return { command: "exit 1" }
  if (["edit", "write"].includes(tool)) return { filePath: "src/error.ts", content: "" }
  if (tool === "apply_patch") return { files: ["src/error.ts"] }
  if (tool === "webfetch") return { url: "https://example.com" }
  if (tool === "websearch") return { query: "failure" }
  if (tool === "task") return { description: "Fail task", subagent_type: "explore" }
  if (tool === "skill") return { name: "failure" }
  return { target: "failure" }
}
