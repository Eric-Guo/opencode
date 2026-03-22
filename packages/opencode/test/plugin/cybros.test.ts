import { describe, expect, mock, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk"
import type { Hooks } from "@opencode-ai/plugin"
import { build, CybrosTrace } from "../../src/plugin/cybros"

const session = {
  id: "s1",
  projectID: "p1",
  directory: "/tmp/app",
  title: "trace me",
  version: "1.2.3",
  time: {
    created: 1,
    updated: 2,
  },
} satisfies Session

const msgs = [
  {
    info: {
      id: "u1",
      sessionID: "s1",
      role: "user",
      time: {
        created: 3,
      },
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
    } satisfies Message & { agent?: string },
  },
  {
    info: {
      id: "a1",
      sessionID: "s1",
      role: "assistant",
      time: {
        created: 4,
      },
      parentID: "u1",
      modelID: "gpt-5",
      providerID: "openai",
      mode: "primary",
      path: {
        cwd: "/tmp/app",
        root: "/tmp/app",
      },
      cost: 1.5,
      tokens: {
        input: 1,
        output: 2,
        reasoning: 3,
        cache: {
          read: 4,
          write: 5,
        },
      },
    } satisfies Message & { agent?: string },
  },
]

async function withToken(token: string | undefined, fn: () => Promise<void>) {
  const prev = Bun.env.THAPE_SSO_BEARER_API_KEY
  if (token === undefined) delete Bun.env.THAPE_SSO_BEARER_API_KEY
  else Bun.env.THAPE_SSO_BEARER_API_KEY = token

  try {
    await fn()
  } finally {
    if (prev === undefined) delete Bun.env.THAPE_SSO_BEARER_API_KEY
    else Bun.env.THAPE_SSO_BEARER_API_KEY = prev
  }
}

async function withFetch(
  stub: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
) {
  const prev = globalThis.fetch
  globalThis.fetch = stub as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = prev
  }
}

describe("plugin.cybros", () => {
  test("builds idle trace payload from session and assistant usage", () => {
    return withToken("token", async () => {
      expect(build(session, msgs)).toEqual({
        session: {
          id: "s1",
          directory: "/tmp/app",
          title: "trace me",
          version: "1.2.3",
          time_created: 1,
        },
        messages: [
          {
            msgID: "a1",
            modelID: "gpt-5",
            providerID: "openai",
            mode: "primary",
            agent: "build",
            cost: 1.5,
            tokens: {
              input: 1,
              output: 2,
              reasoning: 3,
              cache: {
                read: 4,
                write: 5,
              },
            },
          },
        ]
      })
    })
  })

  test("writes local log and posts trace on session idle", async () => {
    await withToken("token", async () => {
      const fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => new Response("ok", { status: 200 }))
      const app = {
        log: mock(async (_arg: unknown) => undefined),
      }
      const hook = await CybrosTrace({
        client: {
          session: {
            get: async () => ({ data: session }),
            messages: async () => ({ data: msgs }),
          },
          app,
        },
      } as unknown as Parameters<typeof CybrosTrace>[0])
      const trace = build(session, msgs)

      await withFetch(fetch, async () => {
        await hook.event?.({
          event: {
            type: "session.idle",
            properties: { sessionID: "s1" },
          },
        } as Parameters<NonNullable<Hooks["event"]>>[0])
      })
      const appCall = app.log.mock.calls[0]
      const fetchCall = fetch.mock.calls[0]

      expect(app.log).toHaveBeenCalledTimes(1)
      expect(appCall?.[0]).toEqual({
        body: {
          service: "plugin.cybros",
          level: "info",
          message: "session.idle",
          extra: trace,
        },
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetchCall?.[0]).toBe("https://cybros.thape.com.cn/api/sigma_agents")
      expect(fetchCall?.[1]).toMatchObject({
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      })
      expect(fetchCall?.[1]?.body).toBe(JSON.stringify(trace))
    })
  })

  test("ignores remote failures and still writes local log", async () => {
    await withToken("token", async () => {
      const fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => new Response("nope", { status: 500, statusText: "Internal Server Error" }))
      const app = {
        log: mock(async (_arg: unknown) => undefined),
      }
      const hook = await CybrosTrace({
        client: {
          session: {
            get: async () => ({ data: session }),
            messages: async () => ({ data: msgs }),
          },
          app,
        },
      } as unknown as Parameters<typeof CybrosTrace>[0])

      await withFetch(fetch, async () => {
        await expect(
          hook.event?.({
            event: {
              type: "session.idle",
              properties: { sessionID: "s1" },
            },
          } as Parameters<NonNullable<Hooks["event"]>>[0]),
        ).resolves.toBeUndefined()
      })

      expect(app.log).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })
})
