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

const profiles = [
  {
    name: "empty running to completed",
    updates: [{ state: "completed" as const, output: "", delay: 350 }],
  },
  {
    name: "one line running to completed",
    updates: [
      { state: "running" as const, output: "one line", delay: 180 },
      { state: "completed" as const, output: "one line", delay: 350 },
    ],
  },
  {
    name: "50 lines arriving incrementally",
    updates: [
      { state: "running" as const, output: lines(1), delay: 100 },
      { state: "running" as const, output: lines(10), delay: 160 },
      { state: "running" as const, output: lines(25), delay: 90 },
      { state: "running" as const, output: lines(50), delay: 220 },
      { state: "completed" as const, output: lines(50), delay: 500 },
    ],
  },
  {
    name: "50 lines arriving in one burst",
    updates: [
      { state: "running" as const, output: lines(50), delay: 180 },
      { state: "completed" as const, output: lines(50), delay: 500 },
    ],
  },
  {
    name: "wide ANSI and CRLF output",
    updates: [
      {
        state: "running" as const,
        output: Array.from({ length: 20 }, (_, index) => `\u001b[32mline ${index}\u001b[0m ${"wide-".repeat(30)}`).join(
          "\r\n",
        ),
        delay: 240,
      },
      {
        state: "completed" as const,
        output: Array.from({ length: 20 }, (_, index) => `line ${index} ${"wide-".repeat(30)}`).join("\n"),
        delay: 500,
      },
    ],
  },
] as const

for (const profile of profiles) {
  test(`keeps rows stable for shell ${profile.name}`, async ({ page }, testInfo) => {
    const shellID = `prt_matrix_${profiles.indexOf(profile)}_01_shell`
    const followingID = `prt_matrix_${profiles.indexOf(profile)}_02_following`
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([shell(shellID, "running"), textPart(followingID, "Following shell row")], {
          completed: false,
        }),
      ],
      settings: { shellToolPartsExpanded: true },
      cpuRate: 4,
      seedHistory: true,
    })
    const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
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
    for (const update of profile.updates) {
      await timeline.send(partUpdated(shell(shellID, update.state, update.output)), update.delay)
    }
    const trace = await stopVisualStabilityProbe(page)
    await expectVisualStability(testInfo, `shell-${profiles.indexOf(profile)}`, trace, {
      flow: ["shell", "following"],
      stable: ["shell", "following"],
      required: ["shell", "following"],
      unique: ["shell", "following"],
      preserveBottomAnchor: true,
      maxPositionReversals: 0,
      maxReversals: 1,
      perMarker: true,
    })
  })
}

test("keeps following row stable when a collapsed shell receives 50 lines", async ({ page }, testInfo) => {
  const shellID = "prt_matrix_collapsed_01_shell"
  const followingID = "prt_matrix_collapsed_02_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "Following collapsed shell")], {
        completed: false,
      }),
    ],
    settings: { shellToolPartsExpanded: false },
    cpuRate: 4,
    seedHistory: true,
  })
  await waitForVisualSettle(page, [`[data-timeline-part-id="${shellID}"]`, `[data-timeline-part-id="${followingID}"]`])
  await startVisualStabilityProbe(page, {
    shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(partUpdated(shell(shellID, "running", lines(50))), 240)
  await timeline.send(partUpdated(shell(shellID, "completed", lines(50))), 500)
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "collapsed-shell", trace, {
    flow: ["shell", "following"],
    stable: ["shell", "following"],
    required: ["shell", "following"],
    unique: ["shell", "following"],
    maxPositionReversals: 0,
    perMarker: true,
  })
})

test("keeps rows stable when a running shell becomes an error", async ({ page }, testInfo) => {
  const shellID = "prt_matrix_error_01_shell"
  const followingID = "prt_matrix_error_02_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([shell(shellID, "running", lines(10)), textPart(followingID, "Following failed shell")], {
        completed: false,
      }),
    ],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
    seedHistory: true,
  })
  await waitForVisualSettle(page, [`[data-timeline-part-id="${shellID}"]`, `[data-timeline-part-id="${followingID}"]`])
  await startVisualStabilityProbe(page, {
    shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await timeline.send(
    partUpdated({
      ...shell(shellID, "error"),
      state: {
        status: "error",
        input: { command: `echo ${shellID}` },
        error: "Command failed after output",
        metadata: {},
        time: { start: 1700000001000, end: 1700000002000 },
      },
    }),
    500,
  )
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "shell-error", trace, {
    flow: ["shell", "following"],
    stable: ["shell", "following"],
    required: ["shell", "following"],
    unique: ["shell", "following"],
    preserveBottomAnchor: true,
    maxPositionReversals: 0,
    perMarker: true,
  })
})

test("keeps rows stable when later text arrives before shell output", async ({ page }, testInfo) => {
  const shellID = "prt_late_text_01_shell"
  const followingID = "prt_late_text_02_following"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([shell(shellID, "running")], { completed: false })],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
    seedHistory: true,
  })
  await waitForVisualSettle(page, [`[data-timeline-part-id="${shellID}"]`])
  await startVisualStabilityProbe(page, {
    shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: {
      selector: `[data-timeline-part-id="${followingID}"]`,
      closest: '[data-timeline-row="AssistantPart"]',
    },
  })
  await timeline.send(partUpdated(textPart(followingID, "Later assistant content arrived before shell output.")), 240)
  await timeline.send(partUpdated(shell(shellID, "running", lines(20))), 300)
  await timeline.send(partUpdated(shell(shellID, "completed", lines(20))), 600)
  const trace = await stopVisualStabilityProbe(page)
  await expectVisualStability(testInfo, "late-text-before-shell-output", trace, {
    flow: ["shell", "following"],
    stable: ["shell"],
    required: ["shell", "following"],
    unique: ["shell", "following"],
    preserveBottomAnchor: true,
    maxPositionReversals: 0,
    perMarker: true,
  })
})

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
