import { describe, expect, test } from "bun:test"
import { writeSessionOutput } from "@/cli/cmd/run/stream"
import type { FooterApi, FooterEvent, StreamCommit } from "@/cli/cmd/run/types"

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

  test("forwards subagent footer snapshots as stream.subagent events", () => {
    const out = footer()

    writeSessionOutput(
      {
        footer: out.api,
      },
      {
        commits: [],
        footer: {
          subagent: {
            tabs: [
              {
                sessionID: "child-1",
                partID: "part-1",
                callID: "call-1",
                label: "Explore",
                description: "Scan reducer paths",
                status: "running",
                lastUpdatedAt: 1,
              },
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
        },
      },
    )

    expect(out.events).toEqual([
      {
        type: "stream.subagent",
        state: {
          tabs: [
            {
              sessionID: "child-1",
              partID: "part-1",
              callID: "call-1",
              label: "Explore",
              description: "Scan reducer paths",
              status: "running",
              lastUpdatedAt: 1,
            },
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
      },
    ])
  })
})
