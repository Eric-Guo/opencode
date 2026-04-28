import { Session as LegacySession } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionMessage } from "@/v2/session-message"
import { SessionV2 } from "@/v2/session"
import { Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "./auth"

export const V2Api = HttpApi.make("v2")
  .add(
    HttpApiGroup.make("v2")
      .add(
        HttpApiEndpoint.get("messages", "/api/session/:sessionID/message", {
          params: { sessionID: SessionID },
          success: Schema.Array(SessionMessage.Message),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.messages",
            summary: "Get v2 session messages",
            description: "Retrieve projected v2 messages for a session directly from the message database.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "v2",
          description: "Experimental v2 routes.",
        }),
      )
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )

export const v2Handlers = Layer.unwrap(
  Effect.gen(function* () {
    const legacySession = yield* LegacySession.Service
    const session = yield* SessionV2.Service

    const messages = Effect.fn("V2HttpApi.messages")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* legacySession.get(ctx.params.sessionID)
      return yield* session.messages(ctx.params.sessionID)
    })

    return HttpApiBuilder.group(V2Api, "v2", (handlers) => handlers.handle("messages", messages))
  }),
).pipe(Layer.provide(LegacySession.defaultLayer), Layer.provide(SessionV2.layer))

export * as V2HttpApi from "./v2"
