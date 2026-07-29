import { FileSystem } from "@opencode-ai/schema/filesystem"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt, PositiveInt, RelativePath } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

const LegacyFileQuery = Schema.Struct({
  directory: Schema.String.pipe(Schema.optional),
  workspace: Schema.String.pipe(Schema.optional),
  path: Schema.String,
})

export const LegacyFileNode = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
}).annotate({ identifier: "LegacyFileNode" })

export const LegacyFileContent = Schema.Struct({
  type: Schema.Literals(["text", "binary"]),
  content: Schema.String,
  diff: Schema.String.pipe(Schema.optional),
  patch: Schema.Struct({
    oldFileName: Schema.String,
    newFileName: Schema.String,
    oldHeader: Schema.String.pipe(Schema.optional),
    newHeader: Schema.String.pipe(Schema.optional),
    hunks: Schema.Array(
      Schema.Struct({
        oldStart: NonNegativeInt,
        oldLines: NonNegativeInt,
        newStart: NonNegativeInt,
        newLines: NonNegativeInt,
        lines: Schema.Array(Schema.String),
      }),
    ),
    index: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  encoding: Schema.Literal("base64").pipe(Schema.optional),
  mimeType: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "LegacyFileContent" })

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description: "Serve one file relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description: "List direct children of one directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.listLegacy", "/file", {
      query: LegacyFileQuery,
      success: Schema.Array(LegacyFileNode),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.fs.listLegacy",
        summary: "List directory for legacy clients",
        description: "Compatibility route for desktop clients using the v1 file SDK.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("fs.readLegacy", "/file/content", {
      query: LegacyFileQuery,
      success: LegacyFileContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.fs.readLegacy",
        summary: "Read file for legacy clients",
        description: "Compatibility route for desktop clients using the v1 file SDK.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
