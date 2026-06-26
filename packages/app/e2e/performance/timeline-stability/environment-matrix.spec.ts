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
  shell,
  textPart,
  userMessage,
  waitForVisualSettle,
} from "./fixture"

for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
  test(`keeps shell growth ordered at device scale ${deviceScaleFactor}`, async ({ page }, testInfo) => {
    const shellID = `prt_dpr_${String(deviceScaleFactor).replace(".", "_")}_01_shell`
    const followingID = `prt_dpr_${String(deviceScaleFactor).replace(".", "_")}_02_following`
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([shell(shellID, "running"), textPart(followingID, "Following scaled shell")], {
          completed: false,
        }),
      ],
      settings: { shellToolPartsExpanded: true },
      cpuRate: 4,
      deviceScaleFactor,
      seedHistory: true,
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
    await timeline.send(partUpdated(shell(shellID, "running", lines(20))), 180)
    await timeline.send(partUpdated(shell(shellID, "completed", lines(20))), 500)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, `dpr-${deviceScaleFactor}`, trace, {
      flow: ["shell", "following"],
      stable: ["shell", "following"],
      unique: ["shell", "following"],
      preserveBottomAnchor: true,
      maxPositionReversals: 0,
      perMarker: true,
    })
  })
}

for (const reducedMotion of [false, true]) {
  test(`keeps shell and status transitions ordered with reduced motion ${reducedMotion}`, async ({
    page,
  }, testInfo) => {
    const shellID = `prt_motion_${reducedMotion}_01_shell`
    const followingID = `prt_motion_${reducedMotion}_02_following`
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([shell(shellID, "running"), textPart(followingID, "Following motion profile")], {
          completed: false,
        }),
      ],
      settings: { shellToolPartsExpanded: true },
      reducedMotion,
      cpuRate: 4,
      seedHistory: true,
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
    await timeline.send(partUpdated(shell(shellID, "completed", lines(10))), 500)
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, `reduced-motion-${reducedMotion}`, trace, {
      flow: ["shell", "following"],
      stable: ["shell", "following"],
      unique: ["shell", "following"],
      preserveBottomAnchor: true,
      maxPositionReversals: 0,
      perMarker: true,
    })
  })
}

for (const locale of ["de", "fr", "ar"]) {
  test(`keeps long translated context status ordered in ${locale}`, async ({ page }, testInfo) => {
    const ids = [`prt_locale_${locale}_01_read`, `prt_locale_${locale}_02_glob`]
    const followingID = `prt_locale_${locale}_following`
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          [
            {
              ...shell(`prt_locale_${locale}_shell`, "completed", "done"),
              id: ids[0],
              tool: "read",
              state: { status: "running", input: { filePath: "src/a.ts" }, metadata: {}, time: { start: 1 } },
            },
            {
              ...shell(`prt_locale_${locale}_glob`, "completed", "done"),
              id: ids[1],
              tool: "glob",
              state: { status: "running", input: { path: ".", pattern: "**/*.ts" }, metadata: {}, time: { start: 1 } },
            },
            textPart(followingID, "Following localized context"),
          ],
          { completed: false },
        ),
      ],
      locale,
      cpuRate: 4,
      seedHistory: true,
    })
    const group = `[data-timeline-part-ids="${ids.join(",")}"]`
    await waitForVisualSettle(page, [group, `[data-timeline-part-id="${followingID}"]`])
    await startVisualStabilityProbe(page, {
      context: { selector: group, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: `[data-timeline-part-id="${followingID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    await timeline.send(
      partUpdated({
        id: ids[0],
        sessionID: "ses_timeline_stability",
        messageID: "msg_1001_timeline_assistant",
        type: "tool",
        callID: "call_read",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "src/a.ts" },
          output: "done",
          title: "done",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }),
      100,
    )
    await timeline.send(
      partUpdated({
        id: ids[1],
        sessionID: "ses_timeline_stability",
        messageID: "msg_1001_timeline_assistant",
        type: "tool",
        callID: "call_glob",
        tool: "glob",
        state: {
          status: "completed",
          input: { path: ".", pattern: "**/*.ts" },
          output: "done",
          title: "done",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }),
      600,
    )
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, `locale-${locale}`, trace, {
      flow: ["context", "following"],
      stable: ["context", "following"],
      unique: ["context", "following"],
      maxPositionReversals: 0,
      perMarker: true,
    })
  })
}

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
