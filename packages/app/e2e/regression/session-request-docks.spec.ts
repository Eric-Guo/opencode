import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { startTimelineDiagnostics, type TimelineDiagnostics } from "../utils/timeline-cdp-diagnostics"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/RequestDocks"
const projectID = "proj_request_docks"
const sessionID = "ses_request_docks"
const title = "Request dock regression"
const activeAssistantID = "msg_0079_b13_request_assistant"
const activeToolID = "prt_0079_request_question"
const activeCallID = "call_0079_request_question"
const questionID = "question-focus-return"
const questionPrompts = [
  {
    header: "Focus path",
    question: "How was focus changing immediately before the timeline jumped?",
    options: [
      { label: "Already in app", description: "The app stayed focused before answering." },
      { label: "Returned to app", description: "The app regained focus before answering." },
    ],
  },
]

type RequestTimelineEvent = {
  directory: string
  payload: {
    id: string
  } & (
    | {
        type: "question.asked"
        properties: {
          id: string
          sessionID: string
          questions: typeof questionPrompts
          tool: { messageID: string; callID: string }
        }
      }
    | {
        type: "question.replied"
        properties: { sessionID: string; requestID: string; answers: string[][] }
      }
    | {
        type: "message.part.updated"
        properties: { sessionID: string; part: Record<string, unknown>; time: number }
      }
    | {
        type: "message.updated"
        properties: { sessionID: string; info: Record<string, unknown> }
      }
  )
}

type QuestionTimelineProbe = Window & {
  __questionTimelineProbe?: {
    blank: boolean
    samples: number
    stop: boolean
    submitted: boolean
    transitionSamples: number
  }
}

const timelineDiagnostics = new WeakMap<Page, TimelineDiagnostics>()

test.beforeEach(async ({ page }, testInfo) => {
  if (process.env.TIMELINE_CDP_TRACE !== "1") return
  timelineDiagnostics.set(page, await startTimelineDiagnostics(page, testInfo))
})

test.afterEach(async ({ page }) => {
  await timelineDiagnostics.get(page)?.stop()
  timelineDiagnostics.delete(page)
})

test("shows a pending question dock", async ({ page }) => {
  await mockServer(page, {
    questions: [
      {
        id: "question-request",
        sessionID,
        questions: [
          {
            header: "Implementation",
            question: "Which implementation should be used?",
            options: [
              { label: "Minimal", description: "Use the smallest correct change" },
              { label: "Extended", description: "Include additional behavior" },
            ],
          },
        ],
      },
    ],
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeVisible()
  await expect(page.locator('[data-component="session-composer"]')).toHaveCount(0)

  const rejectRequests: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (new URL(request.url()).pathname === "/question/question-request/reject") rejectRequests.push(request.url())
  })

  await question.locator('[data-component="icon-button"][data-icon="chevron-down"]').click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByText("Select one answer")).toBeHidden()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeHidden()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeHidden()
  await expect(question.getByRole("button", { name: "Dismiss" })).toBeVisible()
  await expect(question.getByRole("button", { name: "Submit" })).toBeVisible()
  await expect(page.locator('[data-component="question-minimized-dock"]')).toHaveCount(0)
  expect(rejectRequests).toEqual([])

  await question.locator('[data-component="icon-button"][data-icon="chevron-down"]').click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  expect(rejectRequests).toEqual([])

  await question.getByRole("radio", { name: /Minimal/ }).click()
  const reply = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/question/question-request/reply",
  )
  await question.getByRole("button", { name: "Submit" }).click()
  expect((await reply).postDataJSON()).toEqual({ answers: [["Minimal"]] })
})

test("shows a pending permission dock", async ({ page }) => {
  await mockServer(page, {
    permissions: [
      {
        id: "permission-request",
        sessionID,
        permission: "bash",
        patterns: ["git status", "git diff"],
        metadata: {},
        always: [],
      },
    ],
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(permission).toBeVisible()
  await expect(permission.getByText("git status")).toBeVisible()
  await expect(permission.getByText("git diff")).toBeVisible()
  await expect(permission.locator('[data-slot="permission-footer-actions"] button')).toHaveCount(3)
  await expect(page.locator('[data-component="session-composer"]')).toHaveCount(0)

  const reply = page.waitForRequest((request) => request.method() === "POST")
  await permission.getByRole("button", { name: "Allow once" }).click()
  const request = await reply
  expect(new URL(request.url()).pathname).toBe(`/session/${sessionID}/permissions/permission-request`)
  expect(request.postDataJSON()).toEqual({ response: "once" })
})

test("keeps an active split timeline visible when a focused question closes", async ({ page }) => {
  test.setTimeout(180_000)
  // Match the observed long session, assistant chain, and large review history before the focused dock handoff.
  const messages = timelineMessages(80)
  const activeMessage = messages.at(-1)!
  const activeTool = activeMessage.parts[0]!
  const responses: { requestID: string; answers?: string[][] }[] = []
  const transport = await installSseTransport<RequestTimelineEvent>(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: 20,
  })
  await mockServer(page, {
    messages,
    questions: [],
    sessionStatus: { [sessionID]: { type: "busy" } },
    vcsDiff: reviewDiffs(2_754),
    onQuestionReply: async (input) => {
      responses.push(input)
      await transport.send({
        directory,
        payload: {
          id: "evt_question_replied",
          type: "question.replied",
          properties: { sessionID, requestID: questionID, answers: [["Already in app"]] },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await transport.send({
        directory,
        payload: {
          id: "evt_tool_completed",
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              ...activeTool,
              state: {
                status: "completed",
                input: { questions: questionPrompts },
                output: "Questions answered",
                title: "Questions answered",
                metadata: { answers: [["Already in app"]] },
                time: { start: 1700000791000, end: 1700000795000 },
              },
            },
            time: 1700000795000,
          },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await transport.burst([
        {
          directory,
          payload: {
            id: "evt_assistant_completed",
            type: "message.updated",
            properties: {
              sessionID,
              info: {
                ...activeMessage.info,
                time: { ...activeMessage.info.time, completed: 1700000796000 },
              },
            },
          },
        },
        {
          directory,
          payload: {
            id: "evt_continued_assistant",
            type: "message.updated",
            properties: {
              sessionID,
              info: {
                ...activeMessage.info,
                id: "msg_0079_b14_request_assistant",
                time: { created: 1700000797000 },
              },
            },
          },
        },
      ])
      return true
    },
  })

  await page.setViewportSize({ width: 1700, height: 1220 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)
  const reviewToggle = page.getByRole("button", { name: "Toggle review" })
  const review = page.locator('#review-panel [data-component="session-review-v2"]')
  await reviewToggle.click()
  await expect(review).toBeVisible()
  await reviewToggle.click()
  await expect(review).toHaveCount(0)

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const firstPart = page.locator(`[data-timeline-part-id="${messages[0]!.parts[0]!.id}"]`)
  const lastTextPart = page.locator('[data-timeline-part-id="prt_0079_12_request_assistant"]')
  const lastPart = page.locator(`[data-timeline-part-id="${activeToolID}"]`)
  await expect(lastTextPart).toBeInViewport()
  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeInViewport()
  await expect(firstPart).toHaveCount(0)
  await expect.poll(() => distanceFromBottom(scroller)).toBeGreaterThan(-3)
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThan(3)

  const composer = page.locator('[data-component="prompt-input"]')
  await composer.click()
  await expect(composer).toBeFocused()
  await transport.send({
    directory,
    payload: {
      id: "evt_question_asked",
      type: "question.asked",
      properties: {
        id: questionID,
        sessionID,
        questions: questionPrompts,
        tool: { messageID: activeAssistantID, callID: activeCallID },
      },
    },
  })
  await expect(question).toBeVisible()
  await expect(question.getByRole("radio", { name: /Already in app/ })).toBeFocused()
  await expect(lastTextPart).toBeInViewport()
  await expect.poll(() => distanceFromBottom(scroller)).toBeGreaterThan(-3)
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThan(3)
  await page.evaluate(() => {
    const state = { blank: false, samples: 0, stop: false, submitted: false, transitionSamples: 0 }
    ;(window as QuestionTimelineProbe).__questionTimelineProbe = state
    const submit = [...document.querySelectorAll<HTMLButtonElement>('[data-component="dock-prompt"] button')].find(
      (button) => button.textContent?.trim() === "Submit",
    )
    submit?.addEventListener(
      "click",
      () => {
        state.submitted = true
        state.transitionSamples = 0
      },
      { capture: true, once: true },
    )
    const sample = () => {
      const viewport = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
        element.querySelector("[data-timeline-virtual-content]"),
      )
      const view = viewport?.getBoundingClientRect()
      const visible = [...(viewport?.querySelectorAll<HTMLElement>("[data-timeline-part-id]") ?? [])].some((part) => {
        const rect = part.getBoundingClientRect()
        return !!view && rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
      })
      if (view && view.width > 0 && view.height > 0 && !visible) state.blank = true
      state.samples++
      if (state.submitted) state.transitionSamples++
      if (!state.stop) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.waitForFunction(() => ((window as QuestionTimelineProbe).__questionTimelineProbe?.samples ?? 0) >= 2)
  await question.getByRole("radio", { name: /Already in app/ }).click()
  await question.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => responses).toEqual([{ requestID: questionID, answers: [["Already in app"]] }])
  await expect(question).toHaveCount(0)
  await expect(page.locator('[data-component="session-composer"]')).toBeVisible()
  await expect(page.locator('[data-component="toast-v2"]')).toHaveCount(0)
  await expect(lastPart).toBeInViewport()
  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeInViewport()
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
  await expect.poll(() => distanceFromBottom(scroller)).toBeGreaterThan(-3)
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThan(3)
  expect(await visibleTimelineRows(scroller)).toBeGreaterThan(0)
  const probe = await page.evaluate(() => {
    const state = (window as QuestionTimelineProbe).__questionTimelineProbe!
    state.stop = true
    return state
  })
  expect(probe).toMatchObject({ blank: false })
  expect(probe.submitted).toBe(true)
  expect(probe.transitionSamples).toBeGreaterThan(0)
})

async function mockServer(
  page: Page,
  requests: {
    permissions?: unknown[] | (() => unknown[])
    questions?: unknown[] | (() => unknown[])
    messages?: { info: { id: string }; parts: { id: string }[] }[]
    sessionStatus?: unknown
    vcsDiff?: unknown[]
    onQuestionReply?: (input: { requestID: string; answers?: string[][] }) => unknown | Promise<unknown>
  },
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "request-docks",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "request-docks",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: (_, limit, before) => {
      const messages = requests.messages ?? []
      const end = before ? messages.findIndex((message) => message.info.id === before) : messages.length
      const start = Math.max(0, end - limit)
      return {
        items: messages.slice(start, end),
        cursor: start > 0 ? messages[start]!.info.id : undefined,
      }
    },
    message: (_, messageID) => requests.messages?.find((message) => message.info.id === messageID),
    permissions: requests.permissions,
    questions: requests.questions,
    sessionStatus: requests.sessionStatus,
    onQuestionReply: requests.onQuestionReply,
    vcsDiff: requests.vcsDiff,
    fileList: () => [],
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true, shellToolPartsExpanded: true } }),
    )
  })
}

function timelineMessages(turns: number) {
  return Array.from({ length: turns }, (_, index) => {
    const key = String(index).padStart(4, "0")
    const userID = `msg_${key}_a_request_user`
    const active = index === turns - 1
    const user = {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 + index * 10_000 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "opencode", modelID: "claude-opus-4-6" },
      },
      parts: [
        {
          id: `prt_${key}_request_user`,
          sessionID,
          messageID: userID,
          type: "text",
          text: `Request turn ${index}`,
        },
      ],
    }
    const assistants = Array.from({ length: active ? 14 : 1 }, (_, assistantIndex) => {
      const suffix = active ? `b${String(assistantIndex).padStart(2, "0")}` : "b"
      const assistantID = `msg_${key}_${suffix}_request_assistant`
      const current = active && assistantIndex === 13
      const created = 1700000001000 + index * 10_000 + assistantIndex * 100
      return {
        info: {
          id: assistantID,
          sessionID,
          role: "assistant",
          time: { created, ...(current ? {} : { completed: created + 50 }) },
          parentID: userID,
          modelID: "claude-opus-4-6",
          providerID: "opencode",
          mode: "build",
          agent: "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: current
          ? [
              {
                id: activeToolID,
                sessionID,
                messageID: assistantID,
                type: "tool",
                callID: activeCallID,
                tool: "question",
                state: {
                  status: "running",
                  input: { questions: questionPrompts },
                  metadata: {},
                  time: { start: 1700000791000 },
                },
              },
            ]
          : [
              {
                id: `prt_${key}_${assistantIndex}_request_assistant`,
                sessionID,
                messageID: assistantID,
                type: "text",
                text: `Assistant response ${index}.${assistantIndex}. ${"Long timeline content. ".repeat(12)}`,
              },
            ],
      }
    })
    return [user, ...assistants]
  }).flat()
}

function distanceFromBottom(scroller: ReturnType<Page["locator"]>) {
  return scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
}

function reviewDiffs(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const file = `src/focus-${String(index).padStart(4, "0")}.ts`
    return {
      file,
      additions: 1,
      deletions: 1,
      status: "modified",
      patch: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export const focused = false\n+export const focused = true\n`,
    }
  })
}

function visibleTimelineRows(scroller: ReturnType<Page["locator"]>) {
  return scroller.evaluate((element) => {
    const view = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>("[data-timeline-key]")].filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > view.top && rect.top < view.bottom
    }).length
  })
}
