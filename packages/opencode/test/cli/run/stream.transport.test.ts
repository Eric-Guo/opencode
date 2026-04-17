import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { createSessionTransport } from "../../../src/cli/cmd/run/stream.transport"
import type { FooterApi, FooterEvent, RunFilePart, StreamCommit } from "../../../src/cli/cmd/run/types"

function defer<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

function tick() {
  return new Promise<void>((resolve) => queueMicrotask(resolve))
}

async function flush(n = 5) {
  for (let i = 0; i < n; i += 1) {
    await tick()
  }
}

function busy(sessionID = "session-1") {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "busy",
      },
    },
  }
}

function idle(sessionID = "session-1") {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "idle",
      },
    },
  }
}

function assistant(id: string) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: {
        id,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  }
}

function feed() {
  const list: unknown[] = []
  let done = false
  let wake: (() => void) | undefined

  const stream = (async function* () {
    while (!done || list.length > 0) {
      if (list.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }

      yield list.shift()
    }
  })()

  return {
    stream,
    push(value: unknown) {
      list.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      done = true
      wake?.()
      wake = undefined
    },
  }
}

function footer(fn?: (commit: StreamCommit) => void) {
  const commits: StreamCommit[] = []
  const events: FooterEvent[] = []
  let closed = false

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onClose: () => () => {},
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
      fn?.(next)
    },
    idle() {
      return Promise.resolve()
    },
    close() {
      closed = true
    },
    destroy() {
      closed = true
    },
  }

  return { api, commits, events }
}

function sdk(
  src: ReturnType<typeof feed>,
  opt: {
    promptAsync?: (input: unknown, opt?: { signal?: AbortSignal }) => Promise<void>
    status?: () => Promise<{ data?: Record<string, { type: string }> }>
    messages?: (input: {
      sessionID: string
      limit?: number
    }) => Promise<{ data?: Array<{ info: unknown; parts: unknown[] }> }>
    children?: () => Promise<{ data?: Array<{ id: string }> }>
    permissions?: () => Promise<{ data?: unknown[] }>
    questions?: () => Promise<{ data?: unknown[] }>
  } = {},
) {
  return {
    event: {
      subscribe: async () => ({
        stream: src.stream,
      }),
    },
    session: {
      promptAsync: opt.promptAsync ?? (async () => {}),
      status: opt.status ?? (async () => ({ data: {} })),
      messages: opt.messages ?? (async () => ({ data: [] })),
      children: opt.children ?? (async () => ({ data: [] })),
    },
    permission: {
      list: opt.permissions ?? (async () => ({ data: [] })),
    },
    question: {
      list: opt.questions ?? (async () => ({ data: [] })),
    },
  } as unknown as OpencodeClient
}

describe("run stream transport", () => {
  test("bootstraps subagent tabs from parent task parts", async () => {
    const src = feed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk(src, {
        messages: async ({ sessionID }) => {
          if (sessionID !== "session-1") {
            throw new Error("unexpected child bootstrap")
          }

          return {
            data: [
              {
                info: {
                  id: "msg-1",
                  role: "assistant",
                },
                parts: [
                  {
                    id: "task-1",
                    sessionID: "session-1",
                    messageID: "msg-1",
                    type: "tool",
                    callID: "call-1",
                    tool: "task",
                    state: {
                      status: "running",
                      input: {
                        description: "Explore run folder",
                        subagent_type: "explore",
                      },
                      metadata: {
                        sessionId: "child-1",
                      },
                      time: {
                        start: 1,
                      },
                    },
                  },
                ],
              },
            ],
          }
        },
        children: async () => ({
          data: [{ id: "child-1" }],
        }),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      expect(ui.events).toContainEqual({
        type: "stream.subagent",
        state: {
          tabs: [
            expect.objectContaining({
              sessionID: "child-1",
              label: "Explore",
              description: "Explore run folder",
              status: "running",
            }),
          ],
          details: {},
          permissions: [],
          questions: [],
        },
      })

      transport.selectSubagent("child-1")

      expect(ui.events).toContainEqual({
        type: "stream.subagent",
        state: {
          tabs: [
            expect.objectContaining({
              sessionID: "child-1",
              label: "Explore",
              description: "Explore run folder",
              status: "running",
            }),
          ],
          details: {
            "child-1": {
              sessionID: "child-1",
              commits: [],
            },
          },
          permissions: [],
          questions: [],
        },
      })
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("bootstraps resumed child permission input without recent parent task parts", async () => {
    const src = feed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk(src, {
        messages: async ({ sessionID }) => {
          if (sessionID === "session-1") {
            return { data: [] }
          }

          return {
            data: [
              {
                info: {
                  id: "msg-child-1",
                  role: "assistant",
                },
                parts: [
                  {
                    id: "edit-1",
                    sessionID: "child-1",
                    messageID: "msg-child-1",
                    type: "tool",
                    callID: "call-edit-1",
                    tool: "edit",
                    state: {
                      status: "running",
                      input: {
                        filePath: "src/run/subagent-data.ts",
                        diff: "@@ -1 +1 @@",
                      },
                      time: {
                        start: 1,
                      },
                    },
                  },
                ],
              },
            ],
          }
        },
        children: async () => ({
          data: [{ id: "child-1" }],
        }),
        permissions: async () => ({
          data: [
            {
              id: "perm-1",
              sessionID: "child-1",
              permission: "edit",
              patterns: ["src/run/subagent-data.ts"],
              metadata: {},
              always: [],
              tool: {
                messageID: "msg-child-1",
                callID: "call-edit-1",
              },
            },
          ],
        }),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      expect(ui.events).toContainEqual({
        type: "stream.subagent",
        state: {
          tabs: [
            expect.objectContaining({
              sessionID: "child-1",
              status: "running",
            }),
          ],
          details: {},
          permissions: [
            expect.objectContaining({
              id: "perm-1",
              sessionID: "child-1",
              metadata: {
                input: {
                  filePath: "src/run/subagent-data.ts",
                  diff: "@@ -1 +1 @@",
                },
              },
            }),
          ],
          questions: [],
        },
      })

      expect(ui.events).toContainEqual({
        type: "stream.view",
        view: {
          type: "permission",
          request: expect.objectContaining({
            id: "perm-1",
            metadata: {
              input: {
                filePath: "src/run/subagent-data.ts",
                diff: "@@ -1 +1 @@",
              },
            },
          }),
        },
      })
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("respects the includeFiles flag when building prompt payloads", async () => {
    const src = feed()
    const ui = footer()
    const seen: unknown[] = []
    const file: RunFilePart = {
      type: "file",
      url: "file:///tmp/a.ts",
      filename: "a.ts",
      mime: "text/plain",
    }

    const transport = await createSessionTransport({
      sdk: sdk(src, {
        promptAsync: async (input) => {
          seen.push(input)
          queueMicrotask(() => {
            src.push(busy())
            src.push(idle())
          })
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [file],
        includeFiles: true,
      })

      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "again", parts: [] },
        files: [file],
        includeFiles: false,
      })

      expect(seen).toEqual([
        expect.objectContaining({
          parts: [file, { type: "text", text: "hello" }],
        }),
        expect.objectContaining({
          parts: [{ type: "text", text: "again" }],
        }),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("ignores idle events for other sessions", async () => {
    const src = feed()
    const ui = footer()
    const live = defer()
    const transport = await createSessionTransport({
      sdk: sdk(src, {
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            live.resolve()
          })
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
      })

      let done = false
      void task.then(() => {
        done = true
      })

      await live.promise
      await flush()
      src.push(idle("other-session"))
      await flush()
      expect(done).toBe(false)
      src.push(idle())
      await task
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("flushes interrupted output when the active turn aborts", async () => {
    const src = feed()
    const seen = defer()
    const ui = footer((commit) => {
      if (commit.kind === "assistant" && commit.phase === "progress") {
        seen.resolve()
      }
    })
    const transport = await createSessionTransport({
      sdk: sdk(src, {
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(assistant("msg-1"))
            src.push({
              type: "message.part.updated",
              properties: {
                part: {
                  id: "txt-1",
                  messageID: "msg-1",
                  sessionID: "session-1",
                  type: "text",
                  text: "",
                },
              },
            })
            src.push({
              type: "message.part.delta",
              properties: {
                sessionID: "session-1",
                messageID: "msg-1",
                partID: "txt-1",
                field: "text",
                delta: "unfinished",
              },
            })
          })
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await seen.promise
      ctrl.abort()
      await task

      expect(ui.commits).toEqual([
        {
          kind: "assistant",
          text: "unfinished",
          phase: "progress",
          source: "assistant",
          messageID: "msg-1",
          partID: "txt-1",
        },
        {
          kind: "assistant",
          text: "",
          phase: "final",
          source: "assistant",
          messageID: "msg-1",
          partID: "txt-1",
          interrupted: true,
        },
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("ignores stale idle events from an earlier turn", async () => {
    const src = feed()
    const ui = footer()
    const live = defer()
    const done = defer()
    let call = 0
    let state: "idle" | "busy" = "idle"

    const transport = await createSessionTransport({
      sdk: sdk(src, {
        promptAsync: async () => {
          call += 1
          if (call === 1) {
            queueMicrotask(() => {
              state = "busy"
              src.push(busy())
              state = "idle"
              src.push(idle())
            })
            return
          }

          queueMicrotask(() => {
            void (async () => {
              state = "busy"
              src.push(busy())
              live.resolve()
              await done.promise
              state = "idle"
              src.push(idle())
            })()
          })
        },
        status: async () => {
          const data: Record<string, { type: string }> = state === "idle" ? {} : { "session-1": { type: "busy" } }
          return { data }
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "one", parts: [] },
        files: [],
        includeFiles: false,
      })

      let ok = false
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "two", parts: [] },
        files: [],
        includeFiles: false,
      })
      void task.then(() => {
        ok = true
      })

      await live.promise
      await flush()
      src.push(idle())
      await flush()
      expect(ok).toBe(false)

      done.resolve()
      await task
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("rejects concurrent turns", async () => {
    const src = feed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk(src),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "one", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "two", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("prompt already running")

      ctrl.abort()
      await task
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("surfaces event stream faults on later turns", async () => {
    const ui = footer()
    const hit = defer()
    const boom = defer()
    const transport = await createSessionTransport({
      sdk: {
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              hit.resolve()
              await boom.promise
              throw new Error("boom")
            })(),
          }),
        },
        session: {
          promptAsync: async () => {},
          status: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
        },
        permission: {
          list: async () => ({ data: [] }),
        },
        question: {
          list: async () => ({ data: [] }),
        },
      } as unknown as OpencodeClient,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await hit.promise
      boom.resolve()
      await flush()
      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("boom")
    } finally {
      await transport.close()
    }
  })
})
