import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { markVisualStability } from "../../utils/visual-stability"
import { expectSessionTitle } from "../../utils/waits"

export const directory = "C:/OpenCode/TimelineStability"
export const projectID = "proj_timeline_stability"
export const sessionID = "ses_timeline_stability"
export const userID = "msg_1000_timeline_user"
export const assistantID = "msg_1001_timeline_assistant"
export const title = "Timeline visual stability"
export const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

export type Message = {
  info: Record<string, unknown> & { id: string; role: "user" | "assistant" }
  parts: Record<string, unknown>[]
}

export type EventPayload = {
  directory: string
  payload: { type: string; properties: Record<string, unknown> }
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export async function setupTimeline(
  page: Page,
  input: {
    messages?: Message[]
    settings?: Record<string, boolean>
    sessions?: Record<string, unknown>[]
    cpuRate?: number
    viewport?: { width: number; height: number }
    eventRetry?: number
    reducedMotion?: boolean
    locale?: string
    deviceScaleFactor?: number
    seedHistory?: boolean
  } = {},
) {
  const events: EventPayload[] = []
  const sessions = input.sessions ?? [session()]
  const seedHistory = input.seedHistory ?? !!input.cpuRate
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: sessions as ({ id: string } & Record<string, unknown>)[],
    pageMessages: () => ({
      items: [...(seedHistory ? historyMessages(18) : []), ...(input.messages ?? [userMessage(), assistantMessage()])],
    }),
    events: () => events.splice(0, 1),
    eventRetry: input.eventRetry ?? 20,
  })
  await page.addInitScript((settings) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: false,
          shellToolPartsExpanded: false,
          showReasoningSummaries: false,
          showSessionProgressBar: true,
          ...settings,
        },
      }),
    )
  }, input.settings ?? {})
  if (input.locale) {
    await page.addInitScript((locale) => {
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale }))
    }, input.locale)
  }
  if (input.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize(input.viewport ?? { width: 1400, height: 900 })
  if (input.deviceScaleFactor) {
    const devtools = await page.context().newCDPSession(page)
    const viewport = input.viewport ?? { width: 1400, height: 900 }
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: input.deviceScaleFactor,
      mobile: false,
    })
  }
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  if (input.cpuRate && input.cpuRate > 1) {
    const devtools = await page.context().newCDPSession(page)
    await devtools.send("Emulation.setCPUThrottlingRate", { rate: input.cpuRate })
  }

  return {
    async send(event: EventPayload, delay = 0) {
      await markVisualStability(page, describeEvent(event))
      events.push(event)
      if (delay) await page.waitForTimeout(delay)
    },
    async sendAll(sequence: { event: EventPayload; delay: number }[]) {
      for (const item of sequence) {
        await markVisualStability(page, describeEvent(item.event))
        events.push(item.event)
        await page.waitForTimeout(item.delay)
      }
    },
    async settle(frames = 3) {
      await page.evaluate(
        (frames) =>
          new Promise<void>((resolve) => {
            let remaining = frames
            const tick = () => {
              remaining--
              if (remaining <= 0) return resolve()
              requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          }),
        frames,
      )
    },
    async waitForPart(partID: string) {
      await expect(page.locator(`[data-timeline-part-id="${partID}"]`).first()).toBeVisible()
    },
  }
}

function describeEvent(event: EventPayload) {
  const properties = event.payload.properties
  const part = properties.part as { id?: string; type?: string; tool?: string; state?: { status?: string } } | undefined
  if (part) return [event.payload.type, part.id, part.tool ?? part.type, part.state?.status].filter(Boolean).join(":")
  const status = properties.status as { type?: string; attempt?: number } | undefined
  if (status) return [event.payload.type, status.type, status.attempt].filter((value) => value !== undefined).join(":")
  return event.payload.type
}

export function event(type: string, properties: Record<string, unknown>): EventPayload {
  return { directory, payload: { type, properties } }
}

export async function waitForVisualSettle(page: Page, selectors: string[], stableFrames = 3) {
  await page.waitForFunction(
    ({ selectors, stableFrames }) => {
      const elements = selectors.map((selector) => document.querySelector<HTMLElement>(selector))
      if (elements.some((element) => !element)) return false
      return new Promise<boolean>((resolve) => {
        let stable = 0
        let previous = ""
        const sample = () => {
          const signature = JSON.stringify(
            elements.map((element) => {
              const rect = element!.getBoundingClientRect()
              return [Math.round(rect.top * 10), Math.round(rect.bottom * 10), Math.round(rect.height * 10)]
            }),
          )
          stable = signature === previous ? stable + 1 : 0
          previous = signature
          const ordered = elements
            .slice(1)
            .every(
              (element, index) =>
                elements[index]!.getBoundingClientRect().bottom <= element!.getBoundingClientRect().top + 0.5,
            )
          if (stable >= stableFrames && ordered) return resolve(true)
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
    },
    { selectors, stableFrames },
  )
}

export function historyMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const value = String(index).padStart(4, "0")
    const historyUserID = `msg_0${value}_history_a_user`
    return [
      userMessage(undefined, { id: historyUserID, created: 1690000000000 + index * 10_000 }),
      assistantMessage(
        [
          {
            id: `prt_0${value}_history_text`,
            type: "text",
            text: `Historical response ${index}. ${"Existing session content keeps the virtual timeline realistic. ".repeat(5)}`,
          },
        ],
        {
          id: `msg_0${value}_history_b_assistant`,
          parentID: historyUserID,
          created: 1690000001000 + index * 10_000,
        },
      ),
    ]
  }).flat()
}

export function partUpdated(part: Record<string, unknown>) {
  return event("message.part.updated", { sessionID, part, time: Date.now() })
}

export function partDelta(partID: string, delta: string, messageID = assistantID) {
  return event("message.part.delta", { sessionID, messageID, partID, field: "text", delta })
}

export function messageUpdated(info: Record<string, unknown>) {
  return event("message.updated", { sessionID, info })
}

export function status(type: "busy" | "idle" | "retry", attempt = 1) {
  return event("session.status", {
    sessionID,
    status: type === "retry" ? { type, attempt, message: "Rate limited", next: Date.now() + 5_000 } : { type },
  })
}

export function userMessage(
  parts: Record<string, unknown>[] | undefined = [userText("Build the timeline stability matrix.")],
  input: { id?: string; summary?: { diffs: Record<string, unknown>[] }; created?: number } = {},
): Message {
  const id = input.id ?? userID
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: input.created ?? 1700000000000 },
      summary: input.summary ?? { diffs: [] },
      agent: "build",
      model,
    },
    parts: (parts ?? [userText("Build the timeline stability matrix.")]).map((part) => ({
      ...part,
      sessionID,
      messageID: id,
    })),
  }
}

export function assistantMessage(
  parts: Record<string, unknown>[] = [],
  input: {
    id?: string
    parentID?: string
    completed?: boolean
    error?: Record<string, unknown>
    created?: number
  } = {},
): Message {
  const id = input.id ?? assistantID
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: {
        created: input.created ?? 1700000001000,
        ...(input.completed === false ? {} : { completed: (input.created ?? 1700000001000) + 1_000 }),
      },
      parentID: input.parentID ?? userID,
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: "max",
      ...(input.error ? { error: input.error } : {}),
    },
    parts: parts.map((part) => ({ ...part, sessionID, messageID: id })),
  }
}

export function userText(text: string, input: Record<string, unknown> = {}) {
  return { id: "prt_user_text", type: "text", text, ...input }
}

export function textPart(id: string, text: string) {
  return { id, sessionID, messageID: assistantID, type: "text", text }
}

export function reasoningPart(id: string, text: string) {
  return { id, sessionID, messageID: assistantID, type: "reasoning", text, time: { start: 1700000001000 } }
}

export function toolPart(
  id: string,
  tool: string,
  state: ToolStatus,
  input: Record<string, unknown>,
  options: { output?: string; title?: string; metadata?: Record<string, unknown>; error?: string } = {},
) {
  const base = { id, sessionID, messageID: assistantID, type: "tool", callID: `call_${id}`, tool }
  if (state === "pending") return { ...base, state: { status: state, input, raw: "" } }
  if (state === "running")
    return {
      ...base,
      state: {
        status: state,
        input,
        title: options.title,
        metadata: options.metadata ?? {},
        time: { start: 1700000001000 },
      },
    }
  if (state === "error")
    return {
      ...base,
      state: {
        status: state,
        input,
        error: options.error ?? "Tool failed",
        metadata: options.metadata ?? {},
        time: { start: 1700000001000, end: 1700000002000 },
      },
    }
  return {
    ...base,
    state: {
      status: state,
      input,
      output: options.output ?? "Completed",
      title: options.title ?? tool,
      metadata: options.metadata ?? {},
      time: { start: 1700000001000, end: 1700000002000 },
    },
  }
}

export function shell(id: string, state: ToolStatus, output = "", command = `echo ${id}`) {
  return toolPart(id, "bash", state, { command }, { title: command, output, metadata: { command, output } })
}

export function completedAssistantInfo(info: Record<string, unknown>) {
  return { ...info, time: { ...(info.time as Record<string, unknown>), completed: Date.now() } }
}

export function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "timeline-stability",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

export function session(input: Record<string, unknown> = {}) {
  return {
    id: sessionID,
    slug: "timeline-stability",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
    ...input,
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}
