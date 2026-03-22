import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Message, Session } from "@opencode-ai/sdk"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin.cybros" })
const url = "https://cybros.thape.com.cn/api/sigma_agents"

type Row = {
  info: Message & { agent?: string }
}

type Trace = ReturnType<typeof build>

export function build(session: Session, msgs: Row[]) {
  const map = new Map(msgs.flatMap((msg) => (msg.info.role === "user" ? [[msg.info.id, msg.info]] : [])))

  return {
    session: {
      id: session.id,
      directory: session.directory,
      title: session.title,
      version: session.version,
      time_created: session.time.created,
    },
    messages: msgs.flatMap((msg) => {
      if (msg.info.role !== "assistant") return []
      return [
        {
          msgID: msg.info.id,
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
          mode: msg.info.mode,
          agent: msg.info.agent ?? map.get(msg.info.parentID)?.agent,
          cost: msg.info.cost,
          tokens: msg.info.tokens,
        },
      ]
    })
  }
}

export async function post(trace: Trace, sessionID: string) {
  if (!Bun.env.THAPE_SSO_BEARER_API_KEY) {
    log.debug("skipping cybros trace upload; THAPE_SSO_BEARER_API_KEY not set", { sessionID })
    return
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Bun.env.THAPE_SSO_BEARER_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(trace),
    signal: AbortSignal.timeout(10000),
  }).catch((error) => {
    log.warn("failed to upload cybros trace", { sessionID, error })
  })
  if (!res || res.ok) return

  const body = await res.text().catch(() => "")
  log.warn("cybros trace upload returned non-OK status", {
    sessionID,
    status: res.status,
    statusText: res.statusText,
    body: body || undefined,
  })
}

export async function CybrosTrace(input: PluginInput): Promise<Hooks> {
  return {
    event({ event }) {
      if (event.type !== "session.idle") return Promise.resolve()

      const sessionID = event.properties.sessionID

      return Promise.all([
        input.client.session.get({ path: { id: sessionID } }).then((x) => x.data),
        input.client.session.messages({ path: { id: sessionID } }).then((x) => x.data ?? []),
      ])
        .then(async ([session, msgs]) => {
          if (!session) return

          const trace = build(session, msgs)
          const [app] = await Promise.allSettled([
            input.client.app.log({
              body: {
                service: "plugin.cybros",
                level: "info",
                message: "session.idle",
                extra: trace,
              },
            }),
            post(trace, sessionID),
          ])
          if (app.status === "rejected") {
            log.error("failed to write cybros trace", { sessionID, error: app.reason })
          }
        })
        .catch((err) => {
          log.error("failed to write cybros trace", { sessionID, error: err })
        })
    },
  }
}
