import { describe, expect, test } from "bun:test"
import { writeSessionOutput } from "../../../src/cli/cmd/run/stream"
import type { FooterApi, FooterEvent, StreamCommit } from "../../../src/cli/cmd/run/types"

function footer() {
  const events: FooterEvent[] = []
  const commits: StreamCommit[] = []

  const api: FooterApi = {
    isClosed: false,
    onPrompt: () => () => {},
    onClose: () => () => {},
    event: (next) => {
      events.push(next)
    },
    append: (next) => {
      commits.push(next)
    },
    idle: () => Promise.resolve(),
    close: () => {},
    destroy: () => {},
  }

  return { api, events, commits }
}

describe("run stream bridge", () => {
  test("forwards commits in order", () => {
    const out = footer()
    const commits: StreamCommit[] = [
      { kind: "assistant", text: "one", phase: "progress", source: "assistant", partID: "a" },
      { kind: "tool", text: "two", phase: "final", source: "tool", partID: "b", tool: "bash" },
    ]

    writeSessionOutput(
      {
        footer: out.api,
      },
      {
        data: {} as never,
        commits,
      },
    )

    expect(out.commits).toEqual(commits)
  })

  test("defaults status patches to running phase", () => {
    const out = footer()

    writeSessionOutput(
      {
        footer: out.api,
      },
      {
        data: {} as never,
        commits: [],
        footer: {
          patch: {
            status: "assistant responding",
          },
        },
      },
    )

    expect(out.events).toEqual([
      {
        type: "stream.patch",
        patch: {
          phase: "running",
          status: "assistant responding",
        },
      },
    ])
  })

  test("forwards footer view updates as stream.view events", () => {
    const out = footer()

    writeSessionOutput(
      {
        footer: out.api,
      },
      {
        data: {} as never,
        commits: [],
        footer: {
          view: {
            type: "prompt",
          },
        },
      },
    )

    expect(out.events).toEqual([
      {
        type: "stream.view",
        view: {
          type: "prompt",
        },
      },
    ])
  })
})
