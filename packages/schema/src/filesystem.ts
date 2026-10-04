export * as FileSystem from "./filesystem.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"

const Changed = ephemeral({
  type: "filesystem.changed",
  schema: {
    file: Schema.String,
    event: Schema.Literals(["add", "change", "unlink"]),
  },
})
export const Event = { Changed, Definitions: inventory(Changed) }

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  path: RelativePath,
  type: Schema.Literals(["file", "directory"]),
}).annotate({ identifier: "FileSystem.Entry" })

export interface ArchiveEntry extends Schema.Schema.Type<typeof ArchiveEntry> {}
export const ArchiveEntry = Schema.Struct({
  /** Central-directory ordinal; duplicate names remain distinct entries. */
  id: NonNegativeInt,
  /** Display text inside the archive, never a host filesystem path. */
  name: Schema.String,
  directory: Schema.Boolean,
  size: NonNegativeInt,
  compressedSize: NonNegativeInt,
  encrypted: Schema.Boolean,
  symlink: Schema.Boolean,
  compressionMethod: NonNegativeInt,
}).annotate({ identifier: "FileSystem.ArchiveEntry" })

export const Archive = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    size: NonNegativeInt,
    entries: Schema.Array(ArchiveEntry),
  }),
  Schema.Struct({
    status: Schema.Literals(["invalid", "unsupported", "limit", "timeout"]),
    size: NonNegativeInt,
  }),
]).annotate({ identifier: "FileSystem.Archive" })
export type Archive = typeof Archive.Type

export interface Submatch extends Schema.Schema.Type<typeof Submatch> {}
export const Submatch = Schema.Struct({
  text: Schema.String,
  start: NonNegativeInt,
  end: NonNegativeInt,
}).annotate({ identifier: "FileSystem.Submatch" })

export interface Match extends Schema.Schema.Type<typeof Match> {}
export const Match = Schema.Struct({
  entry: Entry,
  line: PositiveInt,
  offset: NonNegativeInt,
  text: Schema.String,
  submatches: Schema.Array(Submatch),
}).annotate({ identifier: "FileSystem.Match" })

export class FindInput extends Schema.Class<FindInput>("FileSystem.FindInput")({
  query: Schema.String,
  type: Schema.Literals(["file", "directory"]).pipe(optional),
  limit: PositiveInt.pipe(optional),
}) {}

export interface Write extends Schema.Schema.Type<typeof Write> {}
export const Write = Schema.Struct({
  path: AbsolutePath,
}).annotate({ identifier: "FileSystem.Write" })
