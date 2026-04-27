import { and, desc, eq } from "@/storage"
import type { Database } from "@/storage"
import { SessionMessage } from "@/v2/session-message"
import { SessionMessageUpdater } from "@/v2/session-message-updater"
import { SessionEvent } from "@/v2/session-event"
import * as DateTime from "effect/DateTime"
import { SyncEvent } from "@/sync"
import { SessionMessageTable } from "./session.sql"
import type { SessionID } from "./schema"

function sqlite(db: Database.TxOrDb, sessionID: SessionID): SessionMessageUpdater.Adapter<void> {
  return {
    getCurrentAssistant() {
      return db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
        .map((row) => ({ id: row.id, type: row.type, ...row.data }) as SessionMessage.Message)
        .find((message): message is SessionMessage.Assistant => message.type === "assistant" && !message.time.completed)
    },
    updateAssistant(assistant) {
      const { id, type, ...data } = assistant
      db.update(SessionMessageTable)
        .set({ data })
        .where(
          and(eq(SessionMessageTable.id, id), eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, type)),
        )
        .run()
    },
    appendMessage(message) {
      const { id, type, ...data } = message
      db.insert(SessionMessageTable)
        .values({
          id,
          session_id: sessionID,
          type,
          time_created: DateTime.toEpochMillis(message.time.created),
          data,
        })
        .run()
    },
    appendPending() {},
    finish() {},
  }
}

function update(db: Database.TxOrDb, event: SessionEvent.Event) {
  SessionMessageUpdater.update(sqlite(db, event.data.sessionID), event)
}

export default [
  SyncEvent.project(SessionEvent.Prompted.Sync, (db, data) => {
    update(db, { type: "session.next.prompted", data })
  }),
  SyncEvent.project(SessionEvent.Synthetic.Sync, (db, data) => {
    update(db, { type: "session.next.synthetic", data })
  }),
  SyncEvent.project(SessionEvent.Step.Started.Sync, (db, data) => {
    update(db, { type: "session.next.step.started", data })
  }),
  SyncEvent.project(SessionEvent.Step.Ended.Sync, (db, data) => {
    update(db, { type: "session.next.step.ended", data })
  }),
  SyncEvent.project(SessionEvent.Text.Started.Sync, (db, data) => {
    update(db, { type: "session.next.text.started", data })
  }),
  SyncEvent.project(SessionEvent.Text.Delta.Sync, () => {}),
  SyncEvent.project(SessionEvent.Text.Ended.Sync, (db, data) => {
    update(db, { type: "session.next.text.ended", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Input.Started.Sync, (db, data) => {
    update(db, { type: "session.next.tool.input.started", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Input.Delta.Sync, () => {}),
  SyncEvent.project(SessionEvent.Tool.Input.Ended.Sync, (db, data) => {
    update(db, { type: "session.next.tool.input.ended", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Called.Sync, (db, data) => {
    update(db, { type: "session.next.tool.called", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Success.Sync, (db, data) => {
    update(db, { type: "session.next.tool.success", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Error.Sync, (db, data) => {
    update(db, { type: "session.next.tool.error", data })
  }),
  SyncEvent.project(SessionEvent.Reasoning.Started.Sync, (db, data) => {
    update(db, { type: "session.next.reasoning.started", data })
  }),
  SyncEvent.project(SessionEvent.Reasoning.Delta.Sync, () => {}),
  SyncEvent.project(SessionEvent.Reasoning.Ended.Sync, (db, data) => {
    update(db, { type: "session.next.reasoning.ended", data })
  }),
  SyncEvent.project(SessionEvent.Retried.Sync, (db, data) => {
    update(db, { type: "session.next.retried", data })
  }),
  SyncEvent.project(SessionEvent.Compacted.Sync, (db, data) => {
    update(db, { type: "session.next.compacted", data })
  }),
]
