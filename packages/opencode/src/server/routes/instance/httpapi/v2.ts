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

export const v2Handlers = HttpApiBuilder.group(V2Api, "v2", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return handlers.handle(
      "messages",
      Effect.fn(function* (ctx) {
        return yield* session.messages(ctx.params.sessionID)
      }),
    )
  }),
).pipe(Layer.provide(SessionV2.defaultLayer))

export * as V2HttpApi from "./v2"
