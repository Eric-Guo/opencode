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
import { createSessionData, flushInterrupted, reduceSessionData } from "./session-data"
import { writeSessionOutput } from "./stream"
import type { FooterApi, RunFilePart, RunInput, RunPrompt, StreamCommit } from "./types"

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
  let wait: Wait | undefined
  let tick = 0
  let fault: unknown
  let closed = false

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
    writeSessionOutput(
      {
        footer: input.footer,
        trace: input.trace,
      },
      {
        data,
        commits,
      },
    )
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
        const next = reduceSessionData({
          data,
          event,
          sessionID: input.sessionID,
          thinking: input.thinking,
          limits: input.limits(),
        })
        data = next.data

        if (next.commits.length > 0 || next.footer?.patch || next.footer?.view) {
          input.trace?.write("reduce.output", {
            commits: next.commits,
            footer: next.footer,
          })
        }

        writeSessionOutput(
          {
            footer: input.footer,
            trace: input.trace,
          },
          next,
        )

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
    close,
  }
}
