import { test } from "@playwright/test"
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

const profiles = [
  { name: "edit", tool: "edit", input: { filePath: "src/edit.ts" } },
  { name: "write", tool: "write", input: { filePath: "src/write.ts", content: source(50, true) } },
  { name: "single patch", tool: "apply_patch", input: { files: ["src/a.ts"] }, single: true },
  {
    name: "multi patch",
    tool: "apply_patch",
    input: { files: ["src/a.ts", "src/b.ts", "src/old.ts", "src/moved.ts"] },
  },
] as const

for (const profile of profiles) {
  test(`stabilizes ${profile.name} pending to completed`, async ({ page }, testInfo) => {
    const partID = `prt_file_matrix_${profiles.indexOf(profile)}`
    const followingID = `prt_file_matrix_following_${profiles.indexOf(profile)}`
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          [
            toolPart(partID, profile.tool, "pending", profile.input),
            textPart(followingID, `Following ${profile.name}`),
          ],
          { completed: false },
        ),
      ],
      settings: { editToolPartsExpanded: true },
      cpuRate: 4,
    })
    await waitForVisualSettle(page, [`[data-timeline-part-id="${partID}"]`, `[data-timeline-part-id="${followingID}"]`])
    await startVisualStabilityProbe(page, {
      tool: { selector: `[data-timeline-part-id="${partID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: `[data-timeline-part-id="${followingID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    await timeline.send(partUpdated(toolPart(partID, profile.tool, "running", profile.input)), 180)
    await timeline.send(partUpdated(completedPart(partID, profile)), 900)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, `file-${profile.name}`, trace, {
      flow: ["tool", "following"],
      stable: ["tool", "following"],
      unique: ["tool", "following"],
      preserveBottomAnchor: true,
      maxPositionReversals: 0,
      maxReversals: 1,
      perMarker: true,
    })
  })
}

function completedPart(partID: string, profile: (typeof profiles)[number]) {
  if (profile.tool === "edit") {
    return toolPart(partID, profile.tool, "completed", profile.input, {
      metadata: {
        filediff: {
          file: "src/edit.ts",
          additions: 50,
          deletions: 50,
          before: source(50, false),
          after: source(50, true),
        },
      },
    })
  }
  if (profile.tool === "write") return toolPart(partID, profile.tool, "completed", profile.input)
  const files =
    "single" in profile && profile.single
      ? [patchFile("src/a.ts", "update")]
      : [
          patchFile("src/a.ts", "update"),
          patchFile("src/b.ts", "add"),
          patchFile("src/old.ts", "delete"),
          { ...patchFile("src/moved.ts", "move"), move: "src/new-place.ts" },
        ]
  return toolPart(partID, profile.tool, "completed", profile.input, { metadata: { files } })
}

function patchFile(filePath: string, type: "add" | "update" | "delete" | "move") {
  return {
    filePath,
    relativePath: filePath,
    type,
    additions: type === "delete" ? 0 : 20,
    deletions: type === "add" ? 0 : 20,
    before: type === "add" ? undefined : source(20, false),
    after: type === "delete" ? undefined : source(20, true),
  }
}

function source(count: number, changed: boolean) {
  return Array.from(
    { length: count },
    (_, index) => `export const value${index} = ${changed ? index + 1 : index}\n`,
  ).join("")
}
