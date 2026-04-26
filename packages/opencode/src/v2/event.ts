import { Identifier } from "@/id/id"
import { SyncEvent } from "@/sync"
import { withStatics } from "@/util/schema"
import * as Schema from "effect/Schema"

export const ID = Schema.String.pipe(
  Schema.brand("Event.ID"),
  withStatics((s) => ({
    create: () => s.make(Identifier.create("evt", "ascending")),
  })),
)
export type ID = Schema.Schema.Type<typeof ID>

export function define<const Type extends string, Fields extends Schema.Struct.Fields>(input: {
  type: Type
  schema: Fields
  aggregate: string
  version?: number
}) {
  const Event = Schema.Struct({
    id: ID,
    metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
    timestamp: Schema.DateTimeUtc,
    type: Schema.Literal(input.type),
    version: Schema.Number.pipe(Schema.optional),
    ...input.schema,
  }).annotate({
    identifier: input.type,
  })

  const Sync = SyncEvent.define({
    type: input.type,
    version: input.version ?? 1,
    aggregate: input.aggregate,
    schema: Event,
  })

  return Object.assign(Event, { Sync })
}

export * as Event from "./event"
