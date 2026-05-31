import { EventV2 } from "@opencode-ai/core/event"
import { Schema } from "effect"

export const Event = {
  Connected: EventV2.define({ type: "server.connected", schema: {} }),
  Heartbeat: EventV2.define({ type: "server.heartbeat", schema: {} }),
  InstanceDisposed: EventV2.define({ type: "server.instance.disposed", schema: { directory: Schema.String } }),
  Disposed: EventV2.define({ type: "global.disposed", schema: {} }),
}
