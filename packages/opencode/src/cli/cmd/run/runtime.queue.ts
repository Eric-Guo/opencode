// Serial prompt queue for direct interactive mode.
//
// Prompts arrive from the footer (user types and hits enter) and queue up
// here. The queue drains one turn at a time: it appends the user row to
// scrollback, calls input.run() to execute the turn through the stream
// transport, and waits for completion before starting the next prompt.
//
// The queue also handles /exit and /quit commands, empty-prompt rejection,
// and tracks per-turn wall-clock duration for the footer status line.
//
// Resolves when the footer closes and all in-flight work finishes.
import * as Locale from "../../../util/locale"
import { isExitCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent, RunPrompt } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

export type QueueInput = {
  footer: FooterApi
  initialInput?: string
  trace?: Trace
  onPrompt?: () => void
  run: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
}

// Runs the prompt queue until the footer closes.
//
// Subscribes to footer prompt events, queues them, and drains one at a
// time through input.run(). If the user submits multiple prompts while
// a turn is running, they queue up and execute in order. The footer shows
// the queue depth so the user knows how many are pending.
export async function runPromptQueue(input: QueueInput): Promise<void> {
  const q: RunPrompt[] = []
  let busy = false
  let closed = input.footer.isClosed
  let ctrl: AbortController | undefined
  let stop: (() => void) | undefined
  let err: unknown
  let hasErr = false
  let done: (() => void) | undefined
  const wait = new Promise<void>((resolve) => {
    done = resolve
  })
  const until = new Promise<void>((resolve) => {
    stop = resolve
  })

  const fail = (error: unknown) => {
    err = error
    hasErr = true
    done?.()
    done = undefined
  }

  const finish = () => {
    if (!closed || busy) {
      return
    }

    done?.()
    done = undefined
  }

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const pump = async () => {
    if (busy || closed) {
      return
    }

    busy = true

    try {
      while (!closed && q.length > 0) {
        const prompt = q.shift()
        if (!prompt) {
          continue
        }

        emit(
          {
            type: "turn.send",
            queue: q.length,
          },
          {
            phase: "running",
            status: "sending prompt",
            queue: q.length,
          },
        )
        const start = Date.now()
        const next = new AbortController()
        ctrl = next
        try {
          const task = input.run(prompt, next.signal).then(
            () => ({ type: "done" as const }),
            (error) => ({ type: "error" as const, error }),
          )
          await input.footer.idle()
          const commit = { kind: "user", text: prompt.text, phase: "start", source: "system" } as const
          input.trace?.write("ui.commit", commit)
          input.footer.append(commit)
          const out = await Promise.race([task, until.then(() => ({ type: "closed" as const }))])
          if (out.type === "closed") {
            next.abort()
            break
          }

          if (out.type === "error") {
            throw out.error
          }
        } finally {
          if (ctrl === next) {
            ctrl = undefined
          }
          const duration = Locale.duration(Math.max(0, Date.now() - start))
          emit(
            {
              type: "turn.duration",
              duration,
            },
            {
              duration,
            },
          )
        }
      }
    } finally {
      busy = false
      emit(
        {
          type: "turn.idle",
          queue: q.length,
        },
        {
          phase: "idle",
          status: "",
          queue: q.length,
        },
      )
      finish()
    }
  }

  const push = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || closed) {
      return
    }

    if (isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    input.onPrompt?.()
    q.push(prompt)
    emit(
      {
        type: "queue",
        queue: q.length,
      },
      {
        queue: q.length,
      },
    )
    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
    void pump().catch(fail)
  }

  const offPrompt = input.footer.onPrompt((prompt) => {
    push(prompt)
  })
  const offClose = input.footer.onClose(() => {
    closed = true
    q.length = 0
    ctrl?.abort()
    stop?.()
    finish()
  })

  try {
    if (closed) {
      return
    }

    push({ text: input.initialInput ?? "", parts: [] })
    await pump()

    if (!closed) {
      await wait
    }

    if (hasErr) {
      throw err
    }
  } finally {
    offPrompt()
    offClose()
  }
}
