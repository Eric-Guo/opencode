import { expect, test } from "bun:test"
import { Schema } from "effect"
import { NexusApplication } from "../src/application"
import { StoreDocument } from "../src/document"
import { TelegramState, telegramState } from "../src/telegram-state"
import { telegramWorkers } from "../src/telegram-workers"
import { telegramJobDiscovery } from "../src/telegram-job-discovery"
import { telegramCandidates, telegramExecution } from "../src/telegram-candidates"
import { storeFixture } from "./fixture/store"

const route = { connection: "connection", chat: "-100", topic: 5, group: true }
const destination = { ...route, chat: "-200", topic: 8 }
const target = { workspace: "workspace", conversation: "parent" }
const owner = {
  id: "owner",
  route,
  target,
  requester: "requester",
  speaker: "speaker",
  source: [1],
  input: "input",
  voice: false,
  terminal: true,
  execution: { turn_public_id: "root-turn", variant_public_id: "root-variant", run_public_id: "root-run" },
}
const variant = {
  public_id: "result",
  source: "original",
  status: "completed",
  run_public_id: "worker-run",
  content: "Canonical worker result",
  attachments: [{ public_id: "upload", filename: "result.txt", content_type: "text/plain", byte_size: 10 }],
}

test.each(["foreground", "scheduled"])("Telegram routes canonical %s results and parent reports", async (origin) => {
  const requests: string[] = []
  const state = { newer: false }
  const service = storeFixture((request) => {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path.endsWith("/children")) return Response.json({ conversations: [], pagination: { next_after: null } })
    if (path.endsWith("/runs/report-run"))
      return Response.json({ run: { public_id: "report-run", status: "completed" } })
    if (path.endsWith("/runs/worker-run"))
      return Response.json({
        run: {
          public_id: "worker-run",
          status: "completed",
          tasks: [
            {
              key: "publish",
              kind: "tool_task",
              tool_name: "file_publish",
              status: "completed",
              lifetime: "turn",
              wake: "immediate",
              after: [],
              waiting_on: [],
            },
          ],
        },
      })
    if (path.endsWith("/runs/worker-run/tasks/publish"))
      return Response.json({
        task: {
          key: "publish",
          kind: "tool_task",
          tool_name: "file_publish",
          status: "completed",
          lifetime: "turn",
          wake: "immediate",
          after: [],
          waiting_on: [],
          content: [
            {
              type: "resource_link",
              uri: "nexus://uploads/upload",
              name: "result.txt",
              mimeType: "text/plain",
              size: 10,
            },
          ],
        },
      })
    if (path.endsWith("/turns/worker-turn"))
      return Response.json({
        turn: {
          public_id: "worker-turn",
          input_public_id: "worker-input",
          position: 1,
          kind: "direct_reply",
          role: "assistant",
          status: "completed",
          visibility: "visible",
          created_at: "2026-01-01T00:00:00Z",
          answering_user_public_id: "bot",
          active_variant: variant,
        },
      })
    if (path.endsWith("/turns"))
      return Response.json({
        turns: [
          {
            public_id: "report-turn",
            input_public_id: "report-input",
            position: 9,
            kind: "callback",
            role: "assistant",
            status: "completed",
            visibility: "visible",
            inherited: false,
            created_at: "2026-01-01T00:00:00Z",
            answering_user_public_id: "bot",
            callback_sources: [
              {
                input_public_id: "callback",
                origin: "background",
                sender_conversation_public_id: "parent",
                sender_run_public_id: origin === "scheduled" ? null : "root-run",
                sender_task_key: "spawn",
                result: {
                  conversation_public_id: "child",
                  input_public_id: "worker-input",
                  turn_public_id: "worker-turn",
                  variant_public_id: state.newer ? "later-result" : "result",
                  run_public_id: "worker-run",
                  requester_speaker_public_id: "speaker",
                  status: "completed",
                },
              },
            ],
            active_variant: {
              ...variant,
              public_id: "report-variant",
              run_public_id: "report-run",
              content: "Parent synthesis",
            },
          },
        ],
        pagination: { before_position: null, after_position: null },
      })
    if (path.endsWith("/turns/worker-turn/variants/result"))
      return Response.json({ turn: { public_id: "worker-turn", inherited: false }, variant })
  })
  try {
    const app = new NexusApplication(
      service.client,
      { workspace: "workspace", agent: "bot", runner: "runner" },
      () => ({}),
    )
    const document = new StoreDocument(
      service.client.profile.storeEntries,
      "opencode.telegram.bot",
      "bot",
      Schema.decodeUnknownSync(TelegramState),
    )
    await document.change(() =>
      origin === "scheduled"
        ? {
            ...telegramState(),
            jobs: [{ id: "job", requester: owner.requester, speaker: owner.speaker, route, target }],
            work: [
              {
                ...owner,
                id: "scheduled:worker-input",
                input: "worker-input",
                schedule: "job",
                worker: true,
                target: { ...target, conversation: "child" },
                execution: { turn_public_id: "worker-turn", variant_public_id: "result", run_public_id: "worker-run" },
              },
            ],
          }
        : { ...telegramState(), work: [{ ...owner, result_route: destination }] },
    )
    await telegramWorkers(document, app, AbortSignal.timeout(2000))
    const registered = (await document.read())!
    expect(registered.work.find((row) => row.worker)?.canonical?.variant_public_id).toBe("result")
    expect(registered.deliveries.map((row) => row.route)).toEqual([route, route])
    await document.change((current) => ({
      ...current!,
      work: current!.work.map((row) => (row.worker ? { ...row, result_route: destination } : row)),
    }))
    state.newer = true
    await telegramWorkers(document, app, AbortSignal.timeout(2000))
    await telegramWorkers(document, app, AbortSignal.timeout(2000))
    const completed = (await document.read())!
    expect(
      completed.deliveries.filter((row) => row.route.chat === destination.chat).map((row) => [row.kind, row.text]),
    ).toEqual([
      ["answer", "Canonical worker result"],
      ["file", ""],
    ])
    expect(requests.filter((path) => path.endsWith("/turns/worker-turn/variants/result"))).toHaveLength(1)
    expect(requests.some((path) => path.includes("later-result"))).toBe(false)
  } finally {
    service.server.stop(true)
  }
})

test("Telegram candidate recovery watches stable turns without following unrelated active variants", async () => {
  const service = storeFixture((request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/events")) return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
    if (path.endsWith("/turns/root-turn/variants"))
      return Response.json({
        turn: { public_id: "root-turn", inherited: false },
        variants: [
          { ...variant, public_id: "old", active: true },
          { ...variant, public_id: "candidate", active: false },
        ],
      })
    if (path.endsWith("/runs/worker-run"))
      return Response.json({ run: { public_id: "worker-run", status: "completed" } })
  })
  try {
    const app = new NexusApplication(
      service.client,
      { workspace: "workspace", agent: "bot", runner: "runner" },
      () => ({}),
    )
    const document = new StoreDocument(
      service.client.profile.storeEntries,
      "opencode.telegram.bot",
      "bot",
      Schema.decodeUnknownSync(TelegramState),
    )
    await document.change(() => ({
      ...telegramState(),
      candidates: [
        {
          id: "control",
          route,
          target,
          requester: "requester",
          speaker: "speaker",
          turn: "root-turn",
          previous: "old",
          known: ["old"],
        },
      ],
    }))
    await telegramCandidates(document, app, AbortSignal.timeout(2000))
    const work = (await document.read())!.work[0]
    expect(work.input).toBe("candidate")
    expect(work.execution?.variant_public_id).toBe("candidate")
    expect((await document.read())!.candidates).toHaveLength(0)
    const snapshot = await telegramExecution(app, work).recover({ signal: AbortSignal.timeout(2000) })
    expect(snapshot?.execution.variant_public_id).toBe("candidate")
    expect(snapshot?.content).toBe("Canonical worker result")
  } finally {
    service.server.stop(true)
  }
})

test("Telegram discovers model-authored schedules through their original execution owner", async () => {
  const service = storeFixture((request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/schedules"))
      return Response.json({
        schedules: ["root-run", "unrelated"].map((run) => ({
          public_id: "schedule-" + run,
          workspace_public_id: "workspace",
          prompt: "Check",
          wake: "auto",
          rule: { kind: "interval", every_seconds: 60 },
          status: "active",
          lock_version: 0,
          answering_user_public_id: "bot",
          source_run_public_id: run,
          speaker_public_id: "speaker",
        })),
        pagination: { next_after: null },
      })
  })
  try {
    const app = new NexusApplication(
      service.client,
      { workspace: "workspace", agent: "main", runner: "runner" },
      () => ({}),
    )
    const document = new StoreDocument(
      service.client.profile.storeEntries,
      "opencode.telegram.bot",
      "bot",
      Schema.decodeUnknownSync(TelegramState),
    )
    await document.change(() => ({ ...telegramState(), work: [owner] }))
    await telegramJobDiscovery(document, app, "bot", AbortSignal.timeout(2000))
    expect((await document.read())?.jobs).toEqual([
      { id: "schedule-root-run", target, route, requester: "requester", speaker: "speaker" },
    ])
  } finally {
    service.server.stop(true)
  }
})
