import z from "zod"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"
import { Database, eq } from "../storage/db"
import { SessionTable } from "../session/session.sql"

export namespace Bus {
  const log = Log.create({ service: "bus" })
  type Subscription = (event: unknown) => void
  type EventProperties = {
    sessionID?: unknown
    part?: {
      sessionID?: unknown
    }
    info?: {
      sessionID?: unknown
      id?: unknown
      directory?: unknown
    }
  }
  const sessions = new Map<string, string>()

  export const InstanceDisposed = BusEvent.define(
    "server.instance.disposed",
    z.object({
      directory: z.string(),
    }),
  )

  const state = Instance.state(
    () => {
      const subscriptions = new Map<any, Subscription[]>()

      return {
        subscriptions,
      }
    },
    async (entry) => {
      const wildcard = entry.subscriptions.get("*")
      if (!wildcard) return
      const event = {
        type: InstanceDisposed.type,
        properties: {
          directory: Instance.directory,
        },
      }
      for (const sub of [...wildcard]) {
        sub(event)
      }
    },
  )

  function sessionID(type: string, properties: unknown): string | undefined {
    const value = properties as EventProperties
    if (typeof value?.sessionID === "string") return value.sessionID
    if (typeof value?.part?.sessionID === "string") return value.part.sessionID
    if (typeof value?.info?.sessionID === "string") return value.info.sessionID
    if (type.startsWith("session.") && typeof value?.info?.id === "string") return value.info.id
  }

  function remember(type: string, properties: unknown) {
    const value = properties as EventProperties
    if (!type.startsWith("session.")) return
    if (typeof value?.info?.id !== "string") return
    if (typeof value?.info?.directory === "string") {
      sessions.set(value.info.id, value.info.directory)
    }
  }

  function directory(type: string, properties: unknown): string {
    remember(type, properties)
    const id = sessionID(type, properties)
    if (!id) return Instance.directory
    const cached = sessions.get(id)
    if (cached) return cached
    const row = Database.use((db) =>
      db.select({ directory: SessionTable.directory }).from(SessionTable).where(eq(SessionTable.id, id)).get(),
    )
    if (!row?.directory) return Instance.directory
    sessions.set(id, row.directory)
    return row.directory
  }

  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload = {
      type: def.type,
      properties,
    }
    log.info("publishing", {
      type: def.type,
    })
    const pending = []
    for (const key of [def.type, "*"]) {
      const match = state().subscriptions.get(key)
      for (const sub of match ?? []) {
        pending.push(sub(payload))
      }
    }
    GlobalBus.emit("event", {
      directory: directory(def.type, properties),
      payload,
    })
    return Promise.all(pending)
  }

  export function subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]> }) => void,
  ) {
    return raw(def.type, callback)
  }

  export function once<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => "done" | undefined,
  ) {
    const unsub = subscribe(def, (event) => {
      if (callback(event)) unsub()
    })
  }

  export function subscribeAll(callback: (event: any) => void) {
    return raw("*", callback)
  }

  function raw(type: string, callback: (event: any) => void) {
    log.info("subscribing", { type })
    const subscriptions = state().subscriptions
    let match = subscriptions.get(type) ?? []
    match.push(callback)
    subscriptions.set(type, match)

    return () => {
      log.info("unsubscribing", { type })
      const match = subscriptions.get(type)
      if (!match) return
      const index = match.indexOf(callback)
      if (index === -1) return
      match.splice(index, 1)
    }
  }
}
