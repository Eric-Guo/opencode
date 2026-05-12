import { describe, expect, test } from "bun:test"
import Notifications from "@/cli/cmd/tui/feature-plugins/system/notifications"
import type { Event, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { TuiAttentionNotifyInput, TuiPluginApi } from "@opencode-ai/plugin/tui"

class Harness {
  notifications: TuiAttentionNotifyInput[] = []
  private handlers = new Map<Event["type"], ((event: Event) => void)[]>()

  api() {
    return {
      attention: {
        notify: async (input: TuiAttentionNotifyInput) => {
          this.notifications.push(input)
          return { ok: true, notification: true, sound: true }
        },
        soundboard: {
          registerPack: () => () => {},
          activate: () => false,
          current: () => "opencode.default",
          list: () => [],
        },
      },
      event: {
        on: <Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) => {
          const list = this.handlers.get(type) ?? []
          const wrapped = handler as (event: Event) => void
          list.push(wrapped)
          this.handlers.set(type, list)
          return () => {
            this.handlers.set(
              type,
              (this.handlers.get(type) ?? []).filter((item) => item !== wrapped),
            )
          }
        },
      },
    } as unknown as TuiPluginApi
  }

  emit(event: Event) {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event)
  }
}

function question(id: string): QuestionRequest {
  return {
    id,
    sessionID: "session",
    questions: [],
  }
}

function permission(id: string): PermissionRequest {
  return {
    id,
    sessionID: "session",
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
  }
}

async function setup() {
  const harness = new Harness()
  await Notifications.tui(harness.api(), undefined, {} as never)
  return harness
}

const questionNotification: TuiAttentionNotifyInput = {
  message: "Question needs input",
  notification: { when: "blurred" },
  sound: { name: "question", when: "always" },
}

const permissionNotification: TuiAttentionNotifyInput = {
  message: "Permission needs input",
  notification: { when: "blurred" },
  sound: { name: "permission", when: "always" },
}

describe("internal notifications TUI plugin", () => {
  test("notifies for question and permission requests with blurred notifications and always-on sounds", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1") })
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-1") })

    expect(harness.notifications).toEqual([questionNotification, permissionNotification])
  })

  test("dedupes pending questions and permissions until they are resolved", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1") })
    harness.emit({ id: "event-2", type: "question.asked", properties: question("question-1") })
    harness.emit({ id: "event-3", type: "question.replied", properties: { sessionID: "session", requestID: "question-1", answers: [] } })
    harness.emit({ id: "event-4", type: "question.asked", properties: question("question-1") })

    harness.emit({ id: "event-5", type: "permission.asked", properties: permission("permission-1") })
    harness.emit({ id: "event-6", type: "permission.asked", properties: permission("permission-1") })
    harness.emit({
      id: "event-7",
      type: "permission.replied",
      properties: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    harness.emit({ id: "event-8", type: "permission.asked", properties: permission("permission-1") })

    expect(harness.notifications).toEqual([
      questionNotification,
      questionNotification,
      permissionNotification,
      permissionNotification,
    ])
  })

  test("notifies when an active session becomes idle and suppresses no-op idle", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } })
    harness.emit({ id: "event-2", type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    harness.emit({ id: "event-3", type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } })

    expect(harness.notifications).toEqual([
      {
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("notifies session errors once and suppresses the following idle done notification", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    harness.emit({
      id: "event-2",
      type: "session.error",
      properties: { sessionID: "session", error: { name: "UnknownError", data: { message: "boom" } } },
    })
    harness.emit({ id: "event-3", type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } })

    expect(harness.notifications).toEqual([
      {
        message: "Session error",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("special-cases aborts and model response timeouts", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", type: "session.status", properties: { sessionID: "abort", status: { type: "busy" } } })
    harness.emit({
      id: "event-2",
      type: "session.error",
      properties: { sessionID: "abort", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
    })
    harness.emit({ id: "event-3", type: "session.status", properties: { sessionID: "timeout", status: { type: "busy" } } })
    harness.emit({
      id: "event-4",
      type: "session.error",
      properties: { sessionID: "timeout", error: { name: "UnknownError", data: { message: "SSE read timed out" } } },
    })

    expect(harness.notifications).toEqual([
      {
        message: "Session aborted",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
      {
        message: "Model stopped responding",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })
})
