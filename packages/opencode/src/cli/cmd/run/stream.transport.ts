// SDK event subscription and prompt turn coordination.
//
// Creates a long-lived event stream subscription and feeds every event
// through the session-data reducer. The reducer produces scrollback commits
// and footer patches, which get forwarded to the footer through stream.ts.
//
// Prompt turns are one-at-a-time: runPromptTurn() sends the prompt to the
// SDK, arms a deferred Wait, and resolves when a session.status idle event
// arrives for this session. If the turn is aborted (user interrupt), it
// flushes any in-progress parts as interrupted entries.
//
// The tick counter prevents stale idle events from resolving the wrong turn.
// We also re-check live session status before resolving an idle event so a
// delayed idle from an older turn cannot complete a newer busy turn.
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import {
  bootstrapSessionData,
  createSessionData,
  flushInterrupted,
  reduceSessionData,
  type SessionData,
} from "./session-data"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentData,
  clearFinishedSubagents,
  createSubagentData,
  listSubagentPermissions,
  listSubagentQuestions,
  listSubagentTabs,
  reduceSubagentData,
  snapshotSelectedSubagentData,
  snapshotSubagentData,
  SUBAGENT_BOOTSTRAP_LIMIT,
  SUBAGENT_CALL_BOOTSTRAP_LIMIT,
  type SubagentData,
} from "./subagent-data"
import { traceFooterOutput, writeSessionOutput } from "./stream"
import type {
  FooterApi,
  FooterOutput,
  FooterPatch,
  FooterSubagentState,
  FooterSubagentTab,
  FooterView,
  RunFilePart,
  RunInput,
  RunPrompt,
  StreamCommit,
} from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type StreamInput = {
  sdk: OpencodeClient
  sessionID: string
  thinking: boolean
  limits: () => Record<string, number>
  footer: FooterApi
  trace?: Trace
  signal?: AbortSignal
}

type Wait = {
  tick: number
  armed: boolean
  live: boolean
  done: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

export type SessionTurnInput = {
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  prompt: RunPrompt
  files: RunFilePart[]
  includeFiles: boolean
  signal?: AbortSignal
}

export type SessionTransport = {
  runPromptTurn(input: SessionTurnInput): Promise<void>
  selectSubagent(sessionID: string | undefined): void
  close(): Promise<void>
}

// Creates a deferred promise tied to a specific turn tick.
function defer(tick: number): Wait {
  let resolve: () => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const done = new Promise<void>((next, fail) => {
    resolve = next
    reject = fail
  })

  return {
    tick,
    armed: false,
    live: false,
    done,
    resolve,
    reject,
  }
}

function sid(event: Event): string | undefined {
  if (event.type === "message.updated") {
    return event.properties.sessionID
  }

  if (event.type === "message.part.delta") {
    return event.properties.sessionID
  }

  if (event.type === "message.part.updated") {
    return event.properties.part.sessionID
  }

  if (
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "session.error" ||
    event.type === "session.status"
  ) {
    return event.properties.sessionID
  }
}

function active(event: Event, sessionID: string): boolean {
  if (sid(event) !== sessionID) {
    return false
  }

  if (event.type !== "session.status") {
    return true
  }

  return event.properties.status.type !== "idle"
}

// Races the turn's deferred promise against an abort signal.
function waitTurn(done: Promise<void>, signal: AbortSignal): Promise<"idle" | "abort"> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve("abort")
      return
    }

    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      resolve("abort")
    }

    signal.addEventListener("abort", onAbort, { once: true })
    done.then(
      () => {
        signal.removeEventListener("abort", onAbort)
        resolve("idle")
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export function formatUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error
  }

  if (error instanceof Error) {
    return error.message || error.name
  }

  if (error && typeof error === "object") {
    const value = error as { message?: unknown; name?: unknown }
    if (typeof value.message === "string" && value.message.trim()) {
      return value.message
    }

    if (typeof value.name === "string" && value.name.trim()) {
      return value.name
    }
  }

  return "unknown error"
}

function sameView(a: FooterView, b: FooterView) {
  if (a.type !== b.type) {
    return false
  }

  if (a.type === "prompt" && b.type === "prompt") {
    return true
  }

  if (a.type === "prompt" || b.type === "prompt") {
    return false
  }

  return a.request === b.request
}

function blockerStatus(view: FooterView) {
  if (view.type === "permission") {
    return "awaiting permission"
  }

  if (view.type === "question") {
    return "awaiting answer"
  }

  return ""
}

function blockerOrder(order: Map<string, number>, id: string) {
  return order.get(id) ?? Number.MAX_SAFE_INTEGER
}

function firstByOrder<T extends { id: string }>(left: T[], right: T[], order: Map<string, number>) {
  return [...left, ...right].sort((a, b) => {
    const next = blockerOrder(order, a.id) - blockerOrder(order, b.id)
    if (next !== 0) {
      return next
    }

    return a.id.localeCompare(b.id)
  })[0]
}

function pickView(data: SessionData, subagent: SubagentData, order: Map<string, number>): FooterView {
  const permission = firstByOrder(data.permissions, listSubagentPermissions(subagent), order)
  if (permission) {
    return { type: "permission", request: permission }
  }

  const question = firstByOrder(data.questions, listSubagentQuestions(subagent), order)
  if (question) {
    return { type: "question", request: question }
  }

  return { type: "prompt" }
}

function composeFooter(input: {
  patch?: FooterPatch
  subagent?: FooterSubagentState
  current: FooterView
  previous: FooterView
}) {
  let footer: FooterOutput | undefined

  if (input.subagent) {
    footer = {
      ...(footer ?? {}),
      subagent: input.subagent,
    }
  }

  if (!sameView(input.previous, input.current)) {
    footer = {
      ...(footer ?? {}),
      view: input.current,
    }
  }

  if (input.current.type !== "prompt") {
    footer = {
      ...(footer ?? {}),
      patch: {
        ...(input.patch ?? {}),
        status: blockerStatus(input.current),
      },
    }
    return footer
  }

  if (input.patch) {
    footer = {
      ...(footer ?? {}),
      patch: input.patch,
    }
    return footer
  }

  if (input.previous.type !== "prompt") {
    footer = {
      ...(footer ?? {}),
      patch: {
        status: "",
      },
    }
  }

  return footer
}

function sameTab(a: FooterSubagentTab | undefined, b: FooterSubagentTab | undefined) {
  if (!a || !b) {
    return false
  }

  return (
    a.sessionID === b.sessionID &&
    a.partID === b.partID &&
    a.callID === b.callID &&
    a.label === b.label &&
    a.description === b.description &&
    a.status === b.status &&
    a.title === b.title &&
    a.toolCalls === b.toolCalls &&
    a.lastUpdatedAt === b.lastUpdatedAt
  )
}

function traceTabs(trace: Trace | undefined, prev: FooterSubagentTab[], next: FooterSubagentTab[]) {
  const before = new Map(prev.map((item) => [item.sessionID, item]))
  const after = new Map(next.map((item) => [item.sessionID, item]))

  for (const [sessionID, tab] of after) {
    if (sameTab(before.get(sessionID), tab)) {
      continue
    }

    trace?.write("subagent.tab", {
      sessionID,
      tab,
    })
  }

  for (const sessionID of before.keys()) {
    if (after.has(sessionID)) {
      continue
    }

    trace?.write("subagent.tab", {
      sessionID,
      cleared: true,
    })
  }
}

// Opens an SDK event subscription and returns a SessionTransport.
//
// The background `watch` loop consumes every SDK event, runs it through the
// reducer, and writes output to the footer. When a session.status idle
// event arrives, it resolves the current turn's Wait so runPromptTurn()
// can return.
//
// The transport is single-turn: only one runPromptTurn() call can be active
// at a time. The prompt queue enforces this from above.
export async function createSessionTransport(input: StreamInput): Promise<SessionTransport> {
  const abort = new AbortController()
  const halt = () => {
    abort.abort()
  }
  input.signal?.addEventListener("abort", halt, { once: true })

  const events = await input.sdk.event.subscribe(undefined, {
    signal: abort.signal,
  })
  input.trace?.write("recv.subscribe", {
    sessionID: input.sessionID,
  })

  const closeStream = () => {
    // Pass undefined explicitly so TS accepts AsyncGenerator.return().
    void events.stream.return(undefined).catch(() => {})
  }

  let data = createSessionData()
  let subagent = createSubagentData()
  let wait: Wait | undefined
  let tick = 0
  let fault: unknown
  let closed = false
  let footerView: FooterView = { type: "prompt" }
  let blockerTick = 0
  let selectedSubagent: string | undefined
  const blockers = new Map<string, number>()

  const currentSubagentState = () => {
    if (selectedSubagent && !subagent.tabs.has(selectedSubagent)) {
      selectedSubagent = undefined
    }

    return snapshotSelectedSubagentData(subagent, selectedSubagent)
  }

  const seedBlocker = (id: string) => {
    if (blockers.has(id)) {
      return
    }

    blockerTick += 1
    blockers.set(id, blockerTick)
  }

  const trackBlocker = (event: Event) => {
    if (event.type !== "permission.asked" && event.type !== "question.asked") {
      return
    }

    if (event.properties.sessionID !== input.sessionID && !subagent.tabs.has(event.properties.sessionID)) {
      return
    }

    seedBlocker(event.properties.id)
  }

  const releaseBlocker = (event: Event) => {
    if (
      event.type !== "permission.replied" &&
      event.type !== "question.replied" &&
      event.type !== "question.rejected"
    ) {
      return
    }

    blockers.delete(event.properties.requestID)
  }

  const syncFooter = (commits: StreamCommit[], patch?: FooterPatch, nextSubagent?: FooterSubagentState) => {
    const current = pickView(data, subagent, blockers)
    const footer = composeFooter({
      patch,
      subagent: nextSubagent,
      current,
      previous: footerView,
    })

    if (commits.length === 0 && !footer) {
      footerView = current
      return
    }

    input.trace?.write("reduce.output", {
      commits,
      footer: traceFooterOutput(footer),
    })
    writeSessionOutput(
      {
        footer: input.footer,
        trace: input.trace,
      },
      {
        commits,
        footer,
      },
    )
    footerView = current
  }

  const bootstrap = async () => {
    const [messages, children, permissions, questions] = await Promise.all([
      input.sdk.session
        .messages({
          sessionID: input.sessionID,
          limit: SUBAGENT_BOOTSTRAP_LIMIT,
        })
        .then((x) => x.data ?? [])
        .catch(() => []),
      input.sdk.session
        .children({
          sessionID: input.sessionID,
        })
        .then((x) => x.data ?? [])
        .catch(() => []),
      input.sdk.permission
        .list()
        .then((x) => x.data ?? [])
        .catch(() => []),
      input.sdk.question
        .list()
        .then((x) => x.data ?? [])
        .catch(() => []),
    ])

    bootstrapSessionData({
      data,
      messages,
      permissions: permissions.filter((item) => item.sessionID === input.sessionID),
      questions: questions.filter((item) => item.sessionID === input.sessionID),
    })
    bootstrapSubagentData({
      data: subagent,
      messages,
      children,
      permissions,
      questions,
    })

    const callSessions = [
      ...new Set(
        listSubagentPermissions(subagent)
          .filter((item) => item.tool && item.metadata?.input === undefined)
          .map((item) => item.sessionID),
      ),
    ]
    if (callSessions.length > 0) {
      await Promise.all(
        callSessions.map(async (sessionID) => {
          const messages = await input.sdk.session
            .messages({
              sessionID,
              limit: SUBAGENT_CALL_BOOTSTRAP_LIMIT,
            })
            .then((x) => x.data ?? [])
            .catch(() => [])

          bootstrapSubagentCalls({
            data: subagent,
            sessionID,
            messages,
          })
        }),
      )
    }

    for (const request of [
      ...data.permissions,
      ...listSubagentPermissions(subagent),
      ...data.questions,
      ...listSubagentQuestions(subagent),
    ].sort((a, b) => a.id.localeCompare(b.id))) {
      seedBlocker(request.id)
    }

    const snapshot = currentSubagentState()
    traceTabs(input.trace, [], snapshot.tabs)
    syncFooter([], undefined, snapshot)
  }

  await bootstrap()

  const idle = async () => {
    try {
      const out = await input.sdk.session.status()
      const state = out.data?.[input.sessionID]
      return !state || state.type === "idle"
    } catch {
      return true
    }
  }

  const fail = (error: unknown) => {
    if (fault) {
      return
    }

    fault = error
    const next = wait
    wait = undefined
    next?.reject(error)
  }

  const touch = (event: Event) => {
    const next = wait
    if (!next || !active(event, input.sessionID)) {
      return
    }

    next.live = true
  }

  const mark = async (event: Event) => {
    if (
      event.type !== "session.status" ||
      event.properties.sessionID !== input.sessionID ||
      event.properties.status.type !== "idle"
    ) {
      return
    }

    const next = wait
    if (!next || !next.armed || !next.live) {
      return
    }

    if (!(await idle()) || wait !== next) {
      return
    }

    tick = next.tick + 1
    wait = undefined
    next.resolve()
  }

  const flush = (type: "turn.abort" | "turn.cancel") => {
    const commits: StreamCommit[] = []
    flushInterrupted(data, commits)
    syncFooter(commits)
    input.trace?.write(type, {
      sessionID: input.sessionID,
    })
  }

  const watch = (async () => {
    try {
      for await (const item of events.stream) {
        if (input.footer.isClosed) {
          break
        }

        const event = item as Event
        input.trace?.write("recv.event", event)
        trackBlocker(event)
        const prevTabs = event.type === "message.part.updated" ? listSubagentTabs(subagent) : undefined
        const next = reduceSessionData({
          data,
          event,
          sessionID: input.sessionID,
          thinking: input.thinking,
          limits: input.limits(),
        })
        data = next.data

        const subagentChanged = reduceSubagentData({
          data: subagent,
          event,
          sessionID: input.sessionID,
          thinking: input.thinking,
          limits: input.limits(),
        })
        if (subagentChanged && prevTabs) {
          traceTabs(input.trace, prevTabs, listSubagentTabs(subagent))
        }
        releaseBlocker(event)

        syncFooter(next.commits, next.footer?.patch, subagentChanged ? currentSubagentState() : undefined)

        touch(event)
        await mark(event)
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        fail(error)
      }
    } finally {
      if (!abort.signal.aborted && !fault) {
        fail(new Error("session event stream closed"))
      }
      closeStream()
    }
  })()

  const runPromptTurn = async (next: SessionTurnInput): Promise<void> => {
    if (next.signal?.aborted || input.footer.isClosed) {
      return
    }

    if (fault) {
      throw fault
    }

    if (wait) {
      throw new Error("prompt already running")
    }

    const prevTabs = listSubagentTabs(subagent)
    if (clearFinishedSubagents(subagent)) {
      const snapshot = currentSubagentState()
      traceTabs(input.trace, prevTabs, snapshot.tabs)
      syncFooter([], undefined, snapshot)
    }

    const item = defer(tick)
    wait = item
    data.announced = false

    const turn = new AbortController()
    const stop = () => {
      turn.abort()
    }
    next.signal?.addEventListener("abort", stop, { once: true })
    abort.signal.addEventListener("abort", stop, { once: true })

    try {
      const req = {
        sessionID: input.sessionID,
        agent: next.agent,
        model: next.model,
        variant: next.variant,
        parts: [
          ...(next.includeFiles ? next.files : []),
          { type: "text" as const, text: next.prompt.text },
          ...next.prompt.parts,
        ],
      }
      input.trace?.write("send.prompt", req)
      await input.sdk.session.promptAsync(req, {
        signal: turn.signal,
      })
      input.trace?.write("send.prompt.ok", {
        sessionID: input.sessionID,
      })

      item.armed = true

      if (turn.signal.aborted || next.signal?.aborted || input.footer.isClosed) {
        if (wait === item) {
          wait = undefined
        }
        flush("turn.abort")
        return
      }

      if (!input.footer.isClosed && !data.announced) {
        input.trace?.write("ui.patch", {
          phase: "running",
          status: "waiting for assistant",
        })
        input.footer.event({
          type: "turn.wait",
        })
      }

      if (tick > item.tick) {
        if (wait === item) {
          wait = undefined
        }
        return
      }

      const state = await waitTurn(item.done, turn.signal)
      if (wait === item) {
        wait = undefined
      }

      if (state === "abort") {
        flush("turn.abort")
      }

      return
    } catch (error) {
      if (wait === item) {
        wait = undefined
      }

      const canceled = turn.signal.aborted || next.signal?.aborted === true || input.footer.isClosed
      if (canceled) {
        flush("turn.cancel")
        return
      }

      if (error === fault) {
        throw error
      }

      input.trace?.write("send.prompt.error", {
        sessionID: input.sessionID,
        error: formatUnknownError(error),
      })
      throw error
    } finally {
      input.trace?.write("turn.end", {
        sessionID: input.sessionID,
      })
      next.signal?.removeEventListener("abort", stop)
      abort.signal.removeEventListener("abort", stop)
    }
  }

  const selectSubagent = (sessionID: string | undefined): void => {
    const next = sessionID && subagent.tabs.has(sessionID) ? sessionID : undefined
    if (selectedSubagent === next) {
      return
    }

    selectedSubagent = next
    syncFooter([], undefined, currentSubagentState())
  }

  const close = async () => {
    if (closed) {
      return
    }

    closed = true
    input.signal?.removeEventListener("abort", halt)
    abort.abort()
    closeStream()
    await watch.catch(() => {})
  }

  return {
    runPromptTurn,
    selectSubagent,
    close,
  }
}
