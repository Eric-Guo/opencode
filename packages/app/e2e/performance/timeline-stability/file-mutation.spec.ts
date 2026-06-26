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
  textPart,
  toolPart,
  userMessage,
  waitForVisualSettle,
} from "./fixture"

test("adds patch files incrementally without resetting outer expansion", async ({ page }, testInfo) => {
  const patchID = "prt_incremental_01_patch"
  const followingID = "prt_incremental_02_following"
  const first = patchFile("src/a.ts", "update")
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(patchID, "apply_patch", "running", { files: [first.filePath] }, { metadata: { files: [first] } }),
          textPart(followingID, "Following incremental patch"),
        ],
        { completed: false },
      ),
    ],
    settings: { editToolPartsExpanded: true },
    cpuRate: 4,
    seedHistory: true,
  })
  const trigger = page.locator(`[data-timeline-part-id="${patchID}"] [data-slot="collapsible-trigger"]`).first()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await waitForVisualSettle(page, [`[data-timeline-part-id="${patchID}"]`, `[data-timeline-part-id="${followingID}"]`])
  await startVisualStabilityProbe(page, {
    patch: { selector: `[data-timeline-part-id="${patchID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  const second = patchFile("src/b.ts", "add")
  const third = patchFile("src/old.ts", "delete")
  await timeline.send(
    partUpdated(
      toolPart(
        patchID,
        "apply_patch",
        "running",
        { files: [first.filePath, second.filePath] },
        { metadata: { files: [first, second] } },
      ),
    ),
    240,
  )
  await timeline.send(
    partUpdated(
      toolPart(
        patchID,
        "apply_patch",
        "completed",
        { files: [first.filePath, second.filePath, third.filePath] },
        { metadata: { files: [first, second, third] } },
      ),
    ),
    800,
  )
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "incremental-patch", trace, {
    flow: ["patch", "following"],
    stable: ["patch", "following"],
    unique: ["patch", "following"],
    preserveBottomAnchor: true,
    maxPositionReversals: 0,
    perMarker: true,
  })
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator('[data-scope="apply-patch"] [data-type="delete"]')).toBeVisible()
})

test("updates edit diagnostics without resetting manual collapse state", async ({ page }) => {
  const editID = "prt_diagnostics_edit"
  const base = editPart(editID, [])
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([base])],
    settings: { editToolPartsExpanded: true },
  })
  const trigger = page.locator(`[data-timeline-part-id="${editID}"] [data-slot="collapsible-trigger"]`).first()
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.send(
    partUpdated(editPart(editID, [diagnostic("First failure", 2), diagnostic("Second failure", 4)])),
    300,
  )
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.send(partUpdated(editPart(editID, [])), 300)
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})

test("preserves nested patch file state through outer collapse and reopen", async ({ page }) => {
  const patchID = "prt_nested_patch"
  const files = [patchFile("src/a.ts", "update"), patchFile("src/b.ts", "add"), patchFile("src/old.ts", "delete")]
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          patchID,
          "apply_patch",
          "completed",
          { files: files.map((file) => file.filePath) },
          { metadata: { files } },
        ),
      ]),
    ],
    settings: { editToolPartsExpanded: true },
  })
  const wrapper = page.locator(`[data-timeline-part-id="${patchID}"]`)
  const outer = wrapper.locator('[data-slot="collapsible-trigger"]').first()
  const deleted = wrapper.locator('[data-scope="apply-patch"] [data-type="delete"]')
  await deleted.getByRole("button").click()
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")
  await outer.click()
  await expect(outer).toHaveAttribute("aria-expanded", "false")
  await outer.click()
  await expect(outer).toHaveAttribute("aria-expanded", "true")
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")
})

function patchFile(filePath: string, type: "add" | "update" | "delete") {
  return {
    filePath,
    relativePath: filePath,
    type,
    additions: type === "delete" ? 0 : 4,
    deletions: type === "add" ? 0 : 3,
    before: type === "add" ? undefined : source(false),
    after: type === "delete" ? undefined : source(true),
  }
}

function editPart(id: string, diagnostics: Record<string, unknown>[]) {
  return toolPart(
    id,
    "edit",
    "completed",
    { filePath: "src/edit.ts" },
    {
      metadata: {
        filediff: { file: "src/edit.ts", additions: 1, deletions: 1, before: source(false), after: source(true) },
        diagnostics,
      },
    },
  )
}

function diagnostic(message: string, line: number) {
  return { message, severity: 1, range: { start: { line, character: 0 }, end: { line, character: 2 } } }
}

function source(changed: boolean) {
  return Array.from({ length: 12 }, (_, index) => `export const value${index} = ${changed ? index + 1 : index}\n`).join(
    "",
  )
}
