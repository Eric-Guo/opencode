import { describe, expect, test } from "bun:test"
import {
  createSession,
  sessionHistory,
  sessionVariant,
  type RunSession,
  type SessionMessages,
} from "@/cli/cmd/run/session.shared"

const model = {
  providerID: "openai",
  modelID: "gpt-5",
}

describe("run session shared", () => {
  test("builds user prompt text from text, file, and agent parts", () => {
    const msgs = [
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "ignore me" }],
      },
      {
        info: {
          role: "user",
          model: {
            ...model,
            variant: "high",
          },
        },
        parts: [
          { type: "text", text: "look @scan" },
          { type: "text", text: "hidden", synthetic: true },
          {
            type: "agent",
            name: "scan",
            source: {
              start: 5,
              end: 10,
              value: "@scan",
            },
          },
          {
            type: "file",
            mime: "text/plain",
            url: "file:///tmp/note.ts",
          },
        ],
      },
    ] as unknown as SessionMessages

    const out = createSession(msgs)
    expect(out.first).toBe(false)
    expect(out.turns).toHaveLength(1)
    expect(out.turns[0]?.prompt.text).toBe("look @scan @note.ts")
    expect(out.turns[0]?.prompt.parts).toEqual([
      {
        type: "agent",
        name: "scan",
        source: {
          start: 5,
          end: 10,
          value: "@scan",
        },
      },
      {
        type: "file",
        mime: "text/plain",
        filename: undefined,
        url: "file:///tmp/note.ts",
        source: {
          type: "file",
          path: "file:///tmp/note.ts",
          text: {
            start: 11,
            end: 19,
            value: "@note.ts",
          },
        },
      },
    ])
  })

  test("reuses existing mentions when file and agent parts have no source", () => {
    const out = createSession([
      {
        info: {
          role: "user",
          model: {
            ...model,
            variant: "high",
          },
        },
        parts: [
          { type: "text", text: "look @scan @note.ts" },
          { type: "agent", name: "scan" },
          {
            type: "file",
            mime: "text/plain",
            url: "file:///tmp/note.ts",
          },
        ],
      },
    ] as unknown as SessionMessages)

    expect(out.turns[0]?.prompt).toEqual({
      text: "look @scan @note.ts",
      parts: [
        {
          type: "agent",
          name: "scan",
          source: {
            start: 5,
            end: 10,
            value: "@scan",
          },
        },
        {
          type: "file",
          mime: "text/plain",
          filename: undefined,
          url: "file:///tmp/note.ts",
          source: {
            type: "file",
            path: "file:///tmp/note.ts",
            text: {
              start: 11,
              end: 19,
              value: "@note.ts",
            },
          },
        },
      ],
    })
  })

  test("dedupes consecutive history entries, drops blanks, and copies prompt parts", () => {
    const parts = [
      {
        type: "agent" as const,
        name: "scan",
        source: {
          start: 0,
          end: 5,
          value: "@scan",
        },
      },
    ]
    const session: RunSession = {
      first: false,
      turns: [
        { prompt: { text: "one", parts }, provider: "openai", model: "gpt-5", variant: "high" },
        { prompt: { text: "one", parts: structuredClone(parts) }, provider: "openai", model: "gpt-5", variant: "high" },
        { prompt: { text: "   ", parts: [] }, provider: "openai", model: "gpt-5", variant: "high" },
        { prompt: { text: "two", parts: [] }, provider: "openai", model: "gpt-5", variant: undefined },
      ],
    }

    const out = sessionHistory(session)

    expect(out.map((item) => item.text)).toEqual(["one", "two"])
    expect(out[0]?.parts).toEqual(parts)
    expect(out[0]?.parts).not.toBe(parts)
    expect(out[0]?.parts[0]).not.toBe(parts[0])
  })

  test("returns the latest matching variant for the active model", () => {
    const session: RunSession = {
      first: false,
      turns: [
        { prompt: { text: "one", parts: [] }, provider: "openai", model: "gpt-5", variant: "high" },
        { prompt: { text: "two", parts: [] }, provider: "anthropic", model: "sonnet", variant: "max" },
        { prompt: { text: "three", parts: [] }, provider: "openai", model: "gpt-5", variant: undefined },
      ],
    }

    expect(sessionVariant(session, model)).toBeUndefined()

    session.turns.push({
      prompt: { text: "four", parts: [] },
      provider: "openai",
      model: "gpt-5",
      variant: "minimal",
    })

    expect(sessionVariant(session, model)).toBe("minimal")
  })
})
