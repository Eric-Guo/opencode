import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { RelativePath } from "@opencode-ai/core/schema"
import { Effect, Option } from "effect"
import path from "path"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const file = yield* fs.read({
            path: RelativePath.make(
              decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
            ),
          })
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      .handle("fs.listLegacy", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const location = yield* Location.Service
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: false,
          }))
        }),
      )
      .handle("fs.readLegacy", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const item = yield* fs.read({ path: RelativePath.make(ctx.query.path) })
          const text = item.content.includes(0)
            ? Option.none<string>()
            : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                Effect.option,
              )
          if (Option.isSome(text)) return { type: "text" as const, content: text.value.trim() }
          return {
            type: "binary" as const,
            content: Buffer.from(item.content).toString("base64"),
            encoding: "base64" as const,
            mimeType: item.mime,
          }
        }),
      )
  }),
)
