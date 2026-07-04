import type { Page } from "@playwright/test"
import { expectSessionTitle } from "../../utils/waits"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { benchmark, expect, withBenchmarkPage } from "../benchmark"
import { fixture } from "./session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "./timeline-test-helpers"
import { waitForStableTimeline } from "./session-tab-switch-probe"

const userID = "msg_parent_hydration_user"
const user = {
  ...fixture.messages[fixture.targetID][0]!,
  info: { ...fixture.messages[fixture.targetID][0]!.info, id: userID, time: { created: 1700001000000 } },
  parts: fixture.messages[fixture.targetID][0]!.parts.map((part, index) => ({
    ...part,
    id: `prt_parent_hydration_user_${index}`,
    messageID: userID,
  })),
}
const assistantSeed = fixture.messages[fixture.targetID][3]!
const assistants = Array.from({ length: 14 }, (_, index) => {
  const messageID = `msg_parent_hydration_${String(index).padStart(2, "0")}`
  return {
    ...assistantSeed,
    info: {
      ...assistantSeed.info,
      id: messageID,
      parentID: userID,
      time: { created: 1700001001000 + index * 1_000, completed: 1700001001500 + index * 1_000 },
    },
    parts: assistantSeed.parts.map((part, partIndex) => ({
      ...part,
      id: `prt_parent_hydration_${String(index).padStart(2, "0")}_${partIndex}`,
      messageID,
    })),
  }
})
const messages = [user, ...assistants]
const target = fixture.sessions.find((session) => session.id === fixture.targetID)!
const lastID = userID
const lastPartID = assistants.at(-1)!.parts.at(-1)!.id

benchmark("hydrates an orphaned latest turn after a cold session click", async ({ browser, report }, testInfo) => {
  benchmark.setTimeout(180_000)
  const results = [] as Awaited<ReturnType<typeof trial>>[]
  for (let run = 0; run < 5; run++) {
    results.push(await withBenchmarkPage(browser, `session-parent-hydration-${run}`, trial, testInfo))
  }
  const timing = results.map((result) => result.metrics.firstCorrectObservedMs).sort((a, b) => a - b)
  report({
    results,
    summary: {
      firstCorrectObservedMs: { min: timing[0], median: timing[2], max: timing.at(-1) },
      blankSamples: results.map((result) => result.metrics.blankSamples),
      listRequests: results.map(
        (result) => result.requests.filter((request) => request.type === "list" && request.phase === "start").length,
      ),
      parentRequests: results.map((result) => result.requests.filter((request) => request.type === "parent").length),
    },
  })
})

async function trial(page: Page) {
  const requests: { type: "list" | "parent"; before?: string; phase?: "start" | "end" }[] = []
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions.filter((session) => session.id === fixture.sourceID),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    messageDelay: 50,
    onMessages: (request) => {
      if (request.sessionID === fixture.targetID) requests.push({ type: "list", before: request.before, phase: request.phase })
    },
    pageMessages: (sessionID, limit, before) => {
      const items = sessionID === fixture.targetID ? messages : fixture.messages[fixture.sourceID]
      const end = before ? items.findIndex((message) => message.info.id === before) : items.length
      const start = Math.max(0, end - limit)
      return { items: items.slice(start, end), cursor: start > 0 ? items[start]!.info.id : undefined }
    },
  })
  await page.route(`**/session/${fixture.targetID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(target) }),
  )
  await page.route(`**/session/${fixture.targetID}/message/${userID}*`, (route) => {
    requests.push({ type: "parent" })
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) })
  })
  await installStressSessionTabs(page, { sessionIDs: [fixture.sourceID] })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)

  const href = stressSessionHref(fixture.targetID)
  await page.evaluate(
    ({ href, title }) => {
      const link = document.createElement("a")
      link.id = "parent-hydration-target"
      link.href = href
      link.textContent = title
      document.body.append(link)
    },
    { href, title: target.title },
  )
  const metrics = await measureFirstCorrect(page, {
    destinationIDs: messages.map((message) => message.info.id),
    sourceIDs: fixture.messages[fixture.sourceID].map((message) => message.info.id),
    lastID,
    lastPartID,
    href,
    switch: async () => {
      await page.locator("#parent-hydration-target").click()
      await expectSessionTitle(page, target.title)
    },
  })
  expect(metrics.firstCorrectObservedMs).not.toBeNull()
  return { metrics, requests }
}

async function measureFirstCorrect(
  page: Page,
  input: {
    destinationIDs: string[]
    sourceIDs: string[]
    lastID: string
    lastPartID: string
    href: string
    switch: () => Promise<void>
  },
) {
  await page.evaluate(({ destinationIDs, sourceIDs, lastID, lastPartID, href }) => {
    const destination = new Set(destinationIDs)
    const source = new Set(sourceIDs)
    const samples: { observedAtMs: number; destination: string[]; source: string[]; last: boolean }[] = []
    document.addEventListener(
      "click",
      (event) => {
        const link = event.target instanceof Element ? event.target.closest("a") : undefined
        if (link?.getAttribute("href") !== href) return
        const started = performance.now()
        const sample = () => {
          setTimeout(() => {
            const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
              element.querySelector("[data-timeline-row]"),
            )
            const visible = root
              ? [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
                  .filter((element) => {
                    const view = root.getBoundingClientRect()
                    const rect = element.getBoundingClientRect()
                    return rect.bottom > view.top && rect.top < view.bottom
                  })
                  .map((element) => element.dataset.messageId!)
              : []
            const latest = root?.querySelector<HTMLElement>(`[data-timeline-part-id="${lastPartID}"]`)
            samples.push({
              observedAtMs: performance.now() - started,
              destination: visible.filter((id) => destination.has(id)),
              source: visible.filter((id) => source.has(id)),
              last: visible.includes(lastID) && !!latest && latest.getBoundingClientRect().height > 0,
            })
            requestAnimationFrame(sample)
          }, 0)
        }
        requestAnimationFrame(sample)
      },
      { capture: true, once: true },
    )
    ;(
      window as Window & {
        __parentHydrationProbe?: typeof samples
      }
    ).__parentHydrationProbe = samples
  }, {
    destinationIDs: input.destinationIDs,
    sourceIDs: input.sourceIDs,
    lastID: input.lastID,
    lastPartID: input.lastPartID,
    href: input.href,
  })
  await input.switch()
  await page.waitForFunction(() =>
    (
      window as Window & {
        __parentHydrationProbe?: { destination: string[]; source: string[]; last: boolean }[]
      }
    ).__parentHydrationProbe?.some((sample) => sample.destination.length > 0 && sample.source.length === 0 && sample.last),
  )
  return page.evaluate(() => {
    const samples = (
      window as Window & {
        __parentHydrationProbe?: { observedAtMs: number; destination: string[]; source: string[]; last: boolean }[]
      }
    ).__parentHydrationProbe!
    return {
      firstCorrectObservedMs: samples.find(
        (sample) => sample.destination.length > 0 && sample.source.length === 0 && sample.last,
      )!.observedAtMs,
      blankSamples: samples.filter((sample) => sample.destination.length === 0 && sample.source.length === 0).length,
    }
  })
}
