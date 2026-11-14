import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { TelegramIngress } from "../src/telegram-ingress"
import { TelegramState, telegramState } from "../src/telegram-state"
import { storeFixture } from "./fixture/store"

const source = "00000000-0000-4000-8000-000000000001"
const peer = "00000000-0000-4000-8000-000000000002"
const sourceConnection = "00000000-0000-4000-8000-000000000003"
const peerConnection = "00000000-0000-4000-8000-000000000004"
const route = { connection: sourceConnection, chat: "-100", topic: 5, group: true }
const target = { workspace: "workspace", conversation: "parent" }
const variant = {
  public_id: "worker-variant",
  source: "original",
  status: "completed",
  run_public_id: "worker-run",
  content: "Independent child answer",
}
const now = 1700000000000

for (const revoke of [false, true])
  test(
    "Telegram peer-Bot delivery retains source receipts" +
      (revoke ? " and refuses revoked target access" : " and the peer's transport identity"),
    async () => {
      const sent: { peer: boolean; text: string }[] = []
      const state = { rateLimit: revoke }
      const service = storeFixture(async (request) => {
        const path = new URL(request.url).pathname
        if (path.endsWith("/getMe"))
          return Response.json({
            ok: true,
            result: { id: path.includes("peer-token") ? 456 : 123, username: "FixtureBot", is_bot: true },
          })
        if (path.endsWith("/setMyCommands")) return Response.json({ ok: true, result: true })
        if (path.endsWith("/profile/agents"))
          return Response.json({
            agents: [source, peer].map((public_id) => ({
              public_id,
              name: "bot-" + public_id,
              scope: "instance",
              handle: "@fixture",
              agent_identifier: public_id,
              steward_public_id: "owner",
              kind: "agent",
              derived_from_public_id: "main",
              description: "Fixture Bot",
              configuration: {
                tool_definitions: [],
                kernel_tools: [],
                runner_executor_public_ids: [],
                mcp_tools: [],
                fallback_models: [],
              },
            })),
          })
        if (path.endsWith("/sendMessage")) {
          const body = (await request.json()) as JsonObject
          const other = path.includes("peer-token")
          if (other && state.rateLimit) {
            state.rateLimit = false
            return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })
          }
          sent.push({ peer: other, text: String(body.text) })
          return Response.json({ ok: true, result: { message_id: 100 + sent.length } })
        }
        if (path.endsWith("/children")) return Response.json({ conversations: [], pagination: { next_after: null } })
        if (path.endsWith("/turns/worker-turn/variants/worker-variant"))
          return Response.json({ turn: { public_id: "worker-turn", inherited: false }, variant })
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
              answering_user_public_id: peer,
              active_variant: variant,
            },
          })
        if (path.endsWith("/turns/report-turn"))
          return Response.json({
            turn: {
              public_id: "report-turn",
              input_public_id: "report-input",
              position: 9,
              kind: "callback",
              role: "assistant",
              status: "completed",
              visibility: "visible",
              created_at: new Date(now).toISOString(),
              answering_user_public_id: source,
              active_variant: {
                ...variant,
                public_id: "report-variant",
                run_public_id: "report-run",
                content: "Parent report",
              },
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
                answering_user_public_id: source,
                callback_sources: [
                  {
                    input_public_id: "callback",
                    origin: "background",
                    sender_conversation_public_id: "parent",
                    sender_run_public_id: "root-run",
                    sender_task_key: "spawn",
                    result: {
                      conversation_public_id: "child",
                      input_public_id: "worker-input",
                      turn_public_id: "worker-turn",
                      variant_public_id: "worker-variant",
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
                  content: "Parent report",
                },
              },
            ],
            pagination: { before_position: null, after_position: null },
          })
        if (path.endsWith("/runs/report-run") || path.endsWith("/runs/worker-run"))
          return Response.json({ run: { public_id: path.split("/").at(-1), status: "completed" } })
      })
      const seed = (bot: string, value: TelegramState) => {
        const id = crypto.randomUUID()
        service.entries.set(id, {
          public_id: id,
          namespace: "opencode.telegram.bot",
          key: bot,
          value: Schema.decodeUnknownSync(Schema.MutableJson)(value),
          lock_version: 0,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        })
        return id
      }
      const sourceID = seed(source, {
        ...telegramState(),
        access: { allowed_users: ["20"], allowed_chats: ["-100"], ignored_users: [] },
        work: [
          {
            id: "owner",
            route,
            target,
            requester: "20",
            speaker: "speaker",
            source: [1],
            input: "root-input",
            voice: false,
            terminal: true,
            execution: { turn_public_id: "root-turn", variant_public_id: "root-variant", run_public_id: "root-run" },
          },
        ],
      })
      const peerID = seed(peer, {
        ...telegramState(),
        access: { allowed_users: ["20"], allowed_chats: ["-100"], ignored_users: [] },
        work: [
          {
            id: "peer",
            route: { ...route, connection: peerConnection },
            target: { workspace: "workspace", conversation: "peer" },
            requester: "20",
            speaker: "peer-speaker",
            source: [2],
            input: "peer-input",
            voice: false,
            terminal: true,
          },
        ],
      })
      for (const bot of [source, peer]) {
        const id = crypto.randomUUID()
        service.entries.set(id, {
          public_id: id,
          namespace: "opencode.bots",
          key: bot,
          value: {
            audience: "external",
            home_workspace_public_id: "workspace",
            preset_public_id: "preset",
            welcome_message: null,
            subagent: false,
          },
          lock_version: 0,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        })
      }
      const settings = {
        connections: { [sourceConnection]: { token: "source-token" }, [peerConnection]: { token: "peer-token" } },
        bots: {
          [source]: {
            enabled: true,
            connection_public_id: sourceConnection,
            target: { chat_id: "-100", topic_id: 5 },
            owner_id: "10",
          },
          [peer]: {
            enabled: true,
            connection_public_id: peerConnection,
            target: { chat_id: "-100", topic_id: 5 },
            owner_id: "10",
          },
        },
      }
      const open = () =>
        new TelegramIngress(settings, {
          application: () =>
            new NexusApplication(
              service.client,
              { agent: "main", runner: "runner", workspace: "workspace" },
              () => ({}),
            ),
          signal: AbortSignal.timeout(3000),
          origin: service.server.url.origin,
        })
      try {
        const ingress = open()
        await ingress.identity(peerConnection)
        await ingress.tick(sourceConnection, now)
        if (revoke) {
          const row = service.entries.get(peerID)!
          const saved = Schema.decodeUnknownSync(TelegramState)(row.value)
          service.entries.set(peerID, {
            ...row,
            lock_version: row.lock_version + 1,
            value: Schema.decodeUnknownSync(Schema.MutableJson)({
              ...saved,
              access: { ...saved.access, allowed_users: [] },
            }),
          })
          await open().tick(sourceConnection, now + 1000)
        }
        const saved = Schema.decodeUnknownSync(TelegramState)(service.entries.get(sourceID)!.value)
        expect(saved.work.find((work) => work.worker)?.result_route).toMatchObject({
          connection: peerConnection,
          destination_bot: peer,
          destination_owner: "20",
        })
        expect(sent.filter((row) => row.text === "Parent report")).toEqual([{ peer: false, text: "Parent report" }])
        expect(sent.filter((row) => row.text === "Independent child answer")).toEqual(
          revoke ? [] : [{ peer: true, text: "Independent child answer" }],
        )
        expect(saved.deliveries.find((row) => row.route.destination_bot === peer)?.status).toBe(
          revoke ? "refused" : "sent",
        )
        expect(Schema.decodeUnknownSync(TelegramState)(service.entries.get(peerID)!.value).deliveries).toHaveLength(0)
      } finally {
        service.server.stop(true)
      }
    },
  )
