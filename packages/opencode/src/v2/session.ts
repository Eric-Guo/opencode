import { SessionMessageTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import { asc, eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionMessage } from "./session-message"

export interface Interface {
  readonly messages: (sessionID: SessionID) => Effect.Effect<SessionMessage.Message[], never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })

    const messages = Effect.fn("V2Session.messages")(function* (sessionID: SessionID) {
      return Database.use((db) =>
        db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
          .all()
          .map((row) => decode(row)),
      )
    })

    return Service.of({ messages })
  }),
)

export const defaultLayer = layer

export * as SessionV2 from "./session"
