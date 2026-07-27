export * as EventV2 from "./event"
export * from "./bus"

import { Event } from "@opencode-ai/schema/event"

export const ID = Event.ID
export type ID = Event.ID

export const Seq = Event.Seq
export type Seq = Event.Seq

export const Version = Event.Version
export type Version = Event.Version

export type { Data, Definition, Payload } from "@opencode-ai/schema/event"
