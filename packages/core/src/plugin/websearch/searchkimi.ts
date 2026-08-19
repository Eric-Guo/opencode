export * as SearchKimi from "./searchkimi.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Duration, Effect, Schema, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const endpoint = "https://api.kimi.com/coding/v1/search"
export const chatEndpoint = "https://api.kimi.com/coding/v1/chat/completions"

const ToolCall = Schema.Struct({
  id: Schema.String.pipe(Schema.optional),
  call_id: Schema.String.pipe(Schema.optional),
  tool_call_id: Schema.String.pipe(Schema.optional),
})

const ToolCallMessage = Schema.Struct({
  tool_calls: Schema.Array(ToolCall).pipe(Schema.optional),
})

const ToolCallResponse = Schema.Struct({
  id: Schema.String.pipe(Schema.optional),
  choices: Schema.Array(
    Schema.Struct({
      message: ToolCallMessage.pipe(Schema.optional),
      delta: ToolCallMessage.pipe(Schema.optional),
    }),
  ).pipe(Schema.optional),
})

const SearchResponse = Schema.Struct({
  search_results: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      snippet: Schema.String,
      content: Schema.String.pipe(Schema.optional),
      date: Schema.String.pipe(Schema.optional),
    }),
  ),
})

export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "opencode.websearch.searchkimi",
  effect: Effect.fn("SearchKimi.Plugin")(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.transform((draft) => {
      draft.update("searchkimi", (integration) => (integration.name = "SearchKimi"))
      draft.method.update({
        integrationID: "searchkimi",
        method: { type: "key" },
      })
      draft.method.update({
        integrationID: "searchkimi",
        method: { type: "env", names: ["KIMI_API_KEY"] },
      })
    })
    yield* ctx.websearch.transform((draft) => {
      draft.add({
        id: "searchkimi",
        name: "SearchKimi",
        execute: (input) =>
          Effect.gen(function* () {
            const connection = yield* ctx.integration.connection.active("searchkimi")
            const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
            if (credential?.type !== "key") return yield* Effect.fail(new Error("SearchKimi API key is not configured"))
            const headers = {
              "User-Agent": "KimiCLI/1.48.0",
              Authorization: `Bearer ${credential.key}`,
            }
            const toolCallID = yield* fetchToolCallID(http, input.query, headers)
            const response = yield* search(http, input.query, toolCallID, headers)
            return response.search_results.map((item) => {
              const published = item.date ? Date.parse(item.date) : undefined
              const content = [item.snippet, item.content].filter((value) => value).join("\n\n")
              return {
                url: item.url,
                ...(item.title ? { title: item.title } : {}),
                ...(content ? { content } : {}),
                time: published !== undefined && Number.isFinite(published) ? { published } : {},
              }
            })
          }),
      })
    })
  }),
})

function fetchToolCallID(http: HttpClient.HttpClient, query: string, headers: Record<string, string>) {
  return Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(chatEndpoint).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJson({
        model: "kimi-for-coding",
        stream: false,
        parallel_tool_calls: false,
        tool_choice: {
          type: "builtin_function",
          function: { name: "$web_search" },
        },
        thinking: { type: "disabled" },
        tools: [
          {
            type: "builtin_function",
            function: { name: "$web_search" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Use the $web_search tool to search the web for the following query. Do not add commentary. Query:\n${query}`,
          },
        ],
      }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ToolCallResponse)),
        Effect.timeoutOrElse({
          duration: Duration.seconds(60),
          orElse: () => Effect.fail(new Error("SearchKimi tool call request timed out")),
        }),
      )
    const toolCallID =
      response.choices
        ?.flatMap((choice) => [choice.message, choice.delta])
        .flatMap((message) => message?.tool_calls ?? [])
        .map((toolCall) => toolCall.id ?? toolCall.call_id ?? toolCall.tool_call_id)
        .find((value): value is string => typeof value === "string" && value.trim().length > 0) ??
      (response.id?.trim() ? response.id : undefined)
    if (toolCallID) return toolCallID
    return yield* Effect.fail(new Error("SearchKimi tool call response did not include a tool call id"))
  })
}

function search(http: HttpClient.HttpClient, query: string, toolCallID: string, headers: Record<string, string>) {
  return Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeaders({ ...headers, "X-Msh-Tool-Call-Id": toolCallID }),
      HttpClientRequest.bodyJson({
        text_query: query,
        enable_page_crawling: false,
        timeout_seconds: 120,
        limit: 20,
      }),
    )
    return yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponse)),
        Effect.timeoutOrElse({
          duration: Duration.minutes(10),
          orElse: () => Effect.fail(new Error("SearchKimi search request timed out")),
        }),
      )
  })
}
