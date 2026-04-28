import { SessionID } from "@/session/schema"
import { SessionMessage } from "@/v2/session-message"
import { Prompt } from "@/v2/session-prompt"
import { SessionV2 } from "@/v2/session"
import { Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
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
      .add(
        HttpApiEndpoint.post("prompt", "/api/session/:sessionID/prompt", {
          params: { sessionID: SessionID },
          payload: Schema.Struct({
            prompt: Prompt,
            delivery: SessionV2.Delivery.pipe(Schema.optional),
          }),
          success: SessionMessage.Message,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
            summary: "Send v2 message",
            description: "Create a v2 session message and queue it for the agent loop.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("compact", "/api/session/:sessionID/compact", {
          params: { sessionID: SessionID },
          success: HttpApiSchema.NoContent,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact v2 session",
            description: "Compact a v2 session conversation.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("wait", "/api/session/:sessionID/wait", {
          params: { sessionID: SessionID },
          success: HttpApiSchema.NoContent,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.wait",
            summary: "Wait for v2 session",
            description: "Wait for a v2 session agent loop to become idle.",
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
    return handlers
      .handle(
        "messages",
        Effect.fn(function* (ctx) {
          return yield* session.messages(ctx.params.sessionID)
        }),
      )
      .handle(
        "prompt",
        Effect.fn(function* (ctx) {
          return yield* session.prompt({
            sessionID: ctx.params.sessionID,
            prompt: ctx.payload.prompt,
            delivery: ctx.payload.delivery ?? SessionV2.DefaultDelivery,
          })
        }),
      )
      .handle(
        "compact",
        Effect.fn(function* (ctx) {
          yield* session.compact(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
).pipe(Layer.provide(SessionV2.defaultLayer))

export * as V2HttpApi from "./v2"
