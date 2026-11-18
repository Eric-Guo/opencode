import { executionSnapshot } from "./execution"
import { createHash } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { Schema } from "effect"
import { APIError, MalformedResponse, TransportError, type JsonValue } from "@cybros/agent"
import type { Nexus } from "@opencode/schema/nexus"
import type { NexusApplication } from "./application"
import { StoreDocument } from "./document"
import { TelegramSettings, type TelegramBinding } from "./telegram-settings"
import { TelegramUpdate } from "./telegram-update"
import {
  TelegramAPI,
  TelegramError,
  TelegramRefusal,
  TelegramUncertain,
  telegramChunks,
  telegramBytes,
} from "./telegram-api"
import { telegramConversationCommand, telegramMemoryCommand } from "./telegram-commands"
import { telegramSetup } from "./telegram-setup"
import { telegramJob, telegramTime } from "./telegram-schedules"
import { telegramJobDiscovery } from "./telegram-job-discovery"
import { telegramParticipate } from "./telegram-participation"
import { telegramWorkers } from "./telegram-workers"
import { telegramCandidates, telegramExecution } from "./telegram-candidates"
import { publishedArtifacts } from "./published-artifacts"
import { telegramRender } from "./telegram-render"
import { TelegramTransport } from "./telegram-transport"
import { TelegramProgress } from "./telegram-progress"
import { telegramMenu, telegramHelp } from "./telegram-menu"
import {
  TelegramConnectionState,
  TelegramState,
  telegramState,
  type TelegramBatch,
  type TelegramDelivery,
  type TelegramWork,
} from "./telegram-state"

const Identity = Schema.Struct({ id: Schema.Int, username: Schema.String, is_bot: Schema.Literal(true) })
const Bot = Schema.Struct({
  settings: Schema.Struct({
    audience: Schema.Literals(["owner", "external"]),
    welcome_message: Schema.NullOr(Schema.String),
  }),
  current: Schema.NullOr(Schema.Struct({ public_id: Schema.String, workspace_public_id: Schema.String })),
})
const Selected = Schema.Struct({
  selected: Schema.Struct({ public_id: Schema.String, workspace_public_id: Schema.String }),
})
const Sent = Schema.Struct({ message_id: Schema.Int })
const File = Schema.Struct({ file_path: Schema.String, file_size: Schema.optional(Schema.Number) })
type StateDocument = StoreDocument<TelegramState>

/** Connections own physical polling. Bot state owns durable sources, requester routes and delivery receipts. */
export class TelegramIngress {
  readonly settings
  private readonly stopped = new AbortController()
  private readonly signal: AbortSignal
  private readonly connections = new Map<string, StoreDocument<typeof TelegramConnectionState.Type>>()
  private readonly states = new Map<string, StateDocument>()
  private readonly clients = new Map<string, TelegramAPI>()
  private readonly transports = new Map<string, TelegramTransport>()
  private readonly issues = new Map<string, string>()
  private readonly progress = new TelegramProgress((id) => this.transport(id))
  private running?: Promise<void>
  private identitySlot = Promise.resolve()
  private readonly menus = new Set<string>()

  constructor(
    input: unknown,
    private readonly options: {
      application(): NexusApplication
      signal: AbortSignal
      configure?: (operations: Nexus.ExtensionChange["operations"]) => Promise<unknown>
      origin?: string
    },
  ) {
    this.settings = new TelegramSettings(input)
    this.signal = AbortSignal.any([options.signal, this.stopped.signal])
  }

  run() {
    this.running ??= Promise.all(
      Object.entries(this.settings.connections)
        .filter(([, row]) => row.enabled && row.token)
        .map(async ([id]) => {
          while (!this.signal.aborted) {
            try {
              await this.poll(id)
              this.issues.delete(id)
            } catch (error) {
              if (this.signal.aborted) break
              this.issues.set(id, error instanceof Error ? error.message : "Telegram reconciliation failed.")
              await setTimeout(
                error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 3000,
                undefined,
                { signal: this.signal },
              ).catch(() => {})
            }
          }
        }),
    ).then(() => {})
    return this.running
  }

  async close() {
    this.stopped.abort()
    await this.running
  }

  status() {
    return {
      connections: Object.entries(this.settings.connections).map(([id, row]) => ({
        id,
        name: row.name,
        enabled: row.enabled,
        configured: !!row.token,
        issue: this.issues.get(id) ?? null,
      })),
      bots: Object.entries(this.settings.bots).map(([id, row]) => ({ id, ...row })),
    }
  }

  async command(input: JsonValue): Promise<JsonValue> {
    const action = Schema.decodeUnknownSync(
      Schema.Struct({ action: Schema.String, id: Schema.optional(Schema.String) }),
    )(input)
    if (action.action === "telegram.bot.configure") {
      if (!action.id) throw new Error("Select an editable application Bot.")
      await this.application().bots.command({ action: "bot.read", id: action.id })
    }
    const setup = await telegramSetup(input, this.settings, this.options.configure)
    if (setup !== undefined) return Schema.decodeUnknownSync(Schema.MutableJson)(setup)
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        action: Schema.String,
        id: Schema.optional(Schema.String),
        delivery: Schema.optional(Schema.String),
        list: Schema.optional(Schema.Literals(["allowed_users", "allowed_chats", "ignored_users"])),
        operation: Schema.optional(Schema.Literals(["add", "remove"])),
        value: Schema.optional(Schema.String),
      }),
    )(input)
    if (value.action === "telegram.status") return this.status()
    if (!value.id) throw new Error("Select a Telegram Bot or Connection.")
    if (value.action === "telegram.connection.check") return this.identity(value.id)
    const binding = this.settings.bots[value.id]
    if (!binding) throw new Error("Unknown Telegram Bot binding.")
    const document = this.state(value.id)
    if (value.action === "telegram.access") {
      if (!value.list || !value.operation || !value.value)
        return Schema.decodeUnknownSync(Schema.MutableJson)(((await document.read()) ?? telegramState()).access)
      return Schema.decodeUnknownSync(Schema.MutableJson)(
        (
          await document.change((state) => ({
            ...(state ?? telegramState()),
            access: accessChange(
              binding,
              (state ?? telegramState()).access,
              value.list!,
              value.operation!,
              value.value!,
            ),
          }))
        ).access,
      )
    }
    if (value.action === "telegram.deliveries")
      return ((await document.read()) ?? telegramState()).deliveries.map((row) => ({
        id: row.id,
        status: row.status,
        kind: row.kind,
        chat: row.route.chat,
        topic: row.route.topic,
      }))
    if (value.action === "telegram.delivery.retry") {
      if (!value.delivery) throw new Error("Select an uncertain or refused delivery.")
      const state = (await document.read()) ?? telegramState()
      if (!state.deliveries.some((row) => row.id === value.delivery && ["uncertain", "refused"].includes(row.status)))
        throw new Error("This delivery is not eligible for an explicit retry.")
      await document.change((state) => ({
        ...state!,
        deliveries: state!.deliveries.map((row) => (row.id === value.delivery ? { ...row, status: "pending" } : row)),
      }))
      return { retry_requested: true }
    }
    throw new Error("Unknown Telegram command.")
  }

  async poll(connection: string, now = Date.now()) {
    await this.identity(connection)
    await this.tick(connection, now)
    const document = this.connection(connection)
    const current = (await document.read())!
    const active = (
      await Promise.all(
        Object.entries(this.settings.bots)
          .filter(([, row]) => row.connection_public_id === connection)
          .map(async ([id]) => this.state(id).read()),
      )
    ).some((row) => row && (row.batches.length || row.work.some((work) => !work.terminal)))
    const updates = Schema.decodeUnknownSync(Schema.Array(Schema.MutableJson))(
      await this.api(connection).call("getUpdates", {
        offset: current.offset,
        timeout: active ? 1 : 12,
        allowed_updates: ["message", "callback_query", "stopped_message_generation"],
      }),
    )
    for (const raw of updates) {
      const update = new TelegramUpdate(raw)
      if (update.id < (await document.read())!.offset) continue
      await this.ingest(connection, raw, now)
      await document.change((state) => ({ ...state!, offset: Math.max(state!.offset, update.id + 1) }))
    }
    await this.tick(connection, now)
  }

  async identity(connection: string) {
    const found = this.settings.connections[connection]
    if (!found?.token) throw new Error("Configure this Telegram Connection token first.")
    const physical = Schema.decodeUnknownSync(Identity)(await this.api(connection).call("getMe", {}))
    const identity = { id: String(physical.id), username: physical.username }
    const previous = this.identitySlot
    const released = Promise.withResolvers<void>()
    this.identitySlot = released.promise
    await previous
    try {
      for (const id of Object.keys(this.settings.connections).filter((id) => id !== connection)) {
        if ((await this.connection(id).read())?.identity?.id === identity.id)
          throw new Error("This physical Telegram bot already belongs to another Connection.")
      }
      const saved = await this.connection(connection).change((state) => {
        if (state?.identity && state.identity.id !== identity.id)
          throw new Error(
            "This token identifies another physical Telegram bot. Create a separate Connection; the existing polling offset was preserved.",
          )
        return { ...state, offset: state?.offset ?? 0, identity }
      })
      if (!this.menus.has(connection)) {
        await this.api(connection)
          .call("setMyCommands", {
            commands: telegramMenu.map((row) => ({ command: row.command, description: row.description })),
          })
          .then(() => this.menus.add(connection))
          .catch(() => {})
      }
      return saved.identity!
    } finally {
      released.resolve()
    }
  }

  async ingest(connection: string, raw: unknown, now = Date.now()) {
    const update = new TelegramUpdate(raw)
    if (!update.supported) return
    const exact = Object.entries(this.settings.bots).find(
      ([, row]) =>
        row.enabled &&
        row.connection_public_id === connection &&
        row.target?.chat_id === update.chat &&
        row.target.topic_id === update.topic,
    )
    const known = exact
      ? undefined
      : (
          await Promise.all(
            Object.entries(this.settings.bots)
              .filter(([, row]) => row.enabled && row.connection_public_id === connection)
              .map(async ([id, binding]) => ({ id, binding, state: await this.state(id).read() })),
          )
        ).find((row) =>
          row.state?.work.some((work) =>
            [work.route, ...(work.result_route ? [work.result_route] : [])].some(
              (route) => route.chat === update.chat && route.topic === update.topic && route.connection === connection,
            ),
          ),
        )
    const selected = exact ?? (known ? ([known.id, known.binding] as const) : undefined)
    if (!selected) return
    const [id, binding] = selected
    const identity = (await this.connection(connection).read())?.identity ?? (await this.identity(connection))
    const command = update.command(identity.username)
    if (command?.name === "addressed_elsewhere") return
    const document = this.state(id)
    const state = (await document.read()) ?? telegramState()
    if (state.control?.update !== update.id && update.stale(now, binding.stale_after)) return
    if ((state.consumed[connection] ?? -1) >= update.id) return
    const owner = binding.owner_id === update.requester
    const route = { connection, chat: update.chat, topic: update.topic, group: update.group }
    const finish = async (text?: string, edit?: (state: TelegramState) => TelegramState) => {
      await document.change((current) => {
        const state = edit ? edit(current ?? telegramState()) : (current ?? telegramState())
        return {
          ...state,
          consumed: { ...state.consumed, [connection]: update.id },
          control: null,
          deliveries: text
            ? telegramChunks(text.slice(0, 12000)).reduce(
                (rows, text, index) =>
                  enqueue(rows, {
                    id: key(id, connection, update.id, "notice", index),
                    route,
                    requester: update.requester,
                    text,
                    kind: "notice",
                    status: "pending",
                  }),
                [...state.deliveries],
              )
            : state.deliveries,
        }
      })
    }
    if (!exact) {
      const task = command?.argument.split(/\s+/)[0]
      const work = state.work.find(
        (work) =>
          work.input === task &&
          [work.route, ...(work.result_route ? [work.result_route] : [])].some((candidate) =>
            sameRoute(candidate, route),
          ),
      )
      if (!command || !["status", "stop", "steer"].includes(command.name) || !work || !owner) {
        await finish()
        return
      }
    }
    if (command && ["access", "ignore"].includes(command.name)) {
      if (!owner) {
        await finish("Only the Bot owner can manage access.")
        return
      }
      const words = command.argument.split(/\s+/)
      const list =
        command.name === "ignore"
          ? "ignored_users"
          : ({ users: "allowed_users", chats: "allowed_chats" } as const)[words.shift() as "users" | "chats"]
      const action = words.shift()
      if (!list || !["list", "add", "remove"].includes(action ?? "")) {
        await finish("Use /access users|chats list|add|remove ID, or /ignore list|add|remove ID.")
        return
      }
      if (action === "list") {
        await finish(list + ": " + (state.access[list].join(", ") || "none") + ". Owner: " + binding.owner_id)
        return
      }
      const access = (() => {
        try {
          return accessChange(binding, state.access, list, action as "add" | "remove", words[0] ?? "")
        } catch (error) {
          return error instanceof Error ? error.message : "Invalid access change."
        }
      })()
      if (typeof access === "string") {
        await finish(access)
        return
      }
      await finish("Access updated.", (state) => ({ ...state, access }))
      return
    }
    const bot = Schema.decodeUnknownSync(Bot)(await this.application().bots.command({ action: "bot.read", id }))
    if (
      !permitted(binding, state, update.requester, update.group, update.chat) ||
      (bot.settings.audience === "owner" && (!owner || update.group))
    ) {
      await finish()
      return
    }
    if (update.value.stopped_message_generation) {
      const work = state.work.find(
        (work) =>
          sameRoute(work.route, route) &&
          work.draft?.id === update.value.stopped_message_generation!.draft_id &&
          work.target.conversation === bot.current?.public_id,
      )
      if (!work?.draft || work.terminal || state.control?.update === update.id) {
        await finish()
        return
      }
      const snapshot = await telegramExecution(this.application(), work)
        .recover({ signal: this.signal })
        .then(executionSnapshot)
      if (!snapshot || snapshot.terminal || snapshot.execution.run_public_id !== work.draft.run) {
        await finish()
        return
      }
      await document.change((state) => ({ ...state!, control: { update: update.id } }))
      await this.application()
        .client.workspace(work.target.workspace)
        .run(work.draft.run)
        .stop(false, { signal: this.signal })
      await finish("Stop requested for this execution.")
      return
    }
    const replies =
      update.reply === undefined
        ? []
        : [...(state.messages ?? []), ...state.deliveries].filter(
            (row) => row.message === update.reply && sameRoute(row.route, route),
          )
    const reply = replies.at(-1)
    if (update.reply !== undefined) {
      for (const other of Object.keys(this.settings.bots).filter((other) => other !== id)) {
        const otherState = await this.state(other).read()
        const copied = [...(otherState?.messages ?? []), ...(otherState?.deliveries ?? [])].some(
          (delivery) =>
            delivery.route.destination_bot === id &&
            delivery.message === update.reply &&
            sameRoute(delivery.route, route),
        )
        if (copied) {
          await finish(
            "This is a delivered result from another Bot. Continue in its original chat, or send a new message here for a separate request.",
          )
          return
        }
      }
    }
    if (
      !command &&
      update.reply !== undefined &&
      ((reply?.kind === "question" && !reply.task) ||
        (!reply &&
          String(update.message?.reply_to_message?.from?.id) === identity.id &&
          /^Question \([0-9a-f]{12}\)\n/.test(update.message?.reply_to_message?.text ?? "")))
    ) {
      await finish("That request is no longer available in this chat.")
      return
    }
    const callback = update.value.callback_query?.data?.match(/^(approve|deny|answer|stop):([a-f0-9]+)$/)
    const callbackDelivery =
      callback && state.deliveries.find((row) => row.id === callback[2] && sameRoute(row.route, route))
    const burst = state.batches.some(
      (row) => !row.media && !row.submission && !row.observe && row.requester === update.requester && row.ready > now,
    )
    const knownSource =
      state.work.some((row) => sameRoute(row.route, route) && row.source.includes(update.reply ?? -1)) ||
      state.batches.some(
        (row) => sameRoute(row.route, route) && row.sources.some((source) => source.message === update.reply),
      )
    const addressed = !update.group || update.mentions(identity) || !!reply || knownSource || burst
    const answer = !command && reply?.kind === "question" && !!update.text
    if (command || callback || answer || update.value.stopped_message_generation) {
      const action =
        callback?.[1] ?? (update.value.stopped_message_generation ? "stop" : answer ? "answer" : command?.name)
      const createJob = action === "job" && /^create\s/.test(command?.argument ?? "")
      if (state.control?.update === update.id && !(createJob && state.control.job) && !state.control.fork) {
        await finish(
          "The previous control may have succeeded. It was not repeated. Use /status, /history or /queue to inspect the result.",
        )
        return
      }
      if (update.value.callback_query)
        await this.api(connection)
          .call("answerCallbackQuery", { callback_query_id: update.value.callback_query.id })
          .catch(() => {})
      if (
        ![
          "help",
          "start",
          "whoami",
          "status",
          "tasks",
          "sessions",
          "transcript",
          "context",
          "search",
          "destinations",
          "settings",
        ].includes(action ?? "") &&
        !(action === "history" && (!command?.argument || /^before(?:\s|$)/.test(command.argument)))
      )
        await document.change((state) => ({
          ...(state ?? telegramState()),
          control:
            state?.control?.update === update.id
              ? state.control
              : {
                  update: update.id,
                  clock: now,
                  ...(createJob && bot.current
                    ? {
                        job: {
                          target: { workspace: bot.current.workspace_public_id, conversation: bot.current.public_id },
                          model: state?.model ?? null,
                        },
                      }
                    : {}),
                },
        }))
      const saved = (await document.read())!
      const response = await this.control(
        id,
        binding,
        bot,
        saved,
        update,
        action ?? "unknown",
        answer ? update.text : (command?.argument ?? ""),
        callbackDelivery || reply,
        saved.control?.clock ?? now,
      ).catch((error: unknown) => {
        if (
          error instanceof TransportError ||
          error instanceof MalformedResponse ||
          (error instanceof APIError && (error.status >= 500 || [408, 429].includes(error.status)))
        )
          throw error
        return error instanceof APIError
          ? "Command refused: " + error.status + "."
          : error instanceof Error
            ? error.message
            : "Command unavailable."
      })
      await finish(response)
      return
    }
    if (update.unsupportedMedia) {
      if (addressed) await finish("Send text, a photo, a document, or a voice message.")
      else await finish()
      return
    }
    if (!update.text && !update.media) {
      await finish()
      return
    }
    if (!addressed && !state.observe) {
      await finish()
      return
    }
    const referenced = reply?.input
      ? state.work.find((row) => row.input === reply.input)
      : state.work.find((row) => sameRoute(row.route, route) && row.source.includes(update.reply ?? -1))
    if (referenced && !owner && referenced.requester !== update.requester && !update.mentions(identity)) {
      await finish(
        "Only this task's requester or the Bot owner can continue it. Send a new mention for your own request.",
      )
      return
    }
    if (
      referenced &&
      (owner || referenced.requester === update.requester) &&
      referenced.target.conversation !== bot.current?.public_id &&
      !update.mentions(identity)
    ) {
      await finish(
        "This reply belongs to an earlier conversation. Use its task ID with /steer for active work, or resume that conversation before continuing it.",
      )
      return
    }
    const current =
      bot.current ??
      Schema.decodeUnknownSync(Selected)(
        await this.application().bots.command({
          action: "bot.current",
          id,
          key: key(id, connection, update.id, "current"),
        }),
      ).selected
    const target = { workspace: current.workspace_public_id, conversation: current.public_id }
    const speaker = await this.application().client.profile.registerIngressSpeaker(
      {
        channel_key: "telegram:" + id,
        external_id: update.requester,
        display_name: [update.user?.first_name, update.user?.last_name].filter(Boolean).join(" ") || update.requester,
      },
      { signal: this.signal },
    )
    const observedVoice = !addressed && update.media?.kind === "voice"
    const media = observedVoice ? undefined : update.media
    const quote = reply && ["answer", "participation"].includes(reply.kind) ? reply.text : undefined
    await document.change((current) => {
      const state = current ?? telegramState()
      if (state.batches.reduce((count, row) => count + row.sources.length, 0) >= 20)
        throw new Error("Telegram has twenty pending source messages; wait for admission or stop a queued request.")
      const previous = state.batches.at(-1)
      const batchable =
        previous &&
        !previous.submission &&
        !previous.media &&
        !media &&
        previous.ready > now &&
        previous.requester === update.requester &&
        previous.target.conversation === target.conversation &&
        previous.target.workspace === target.workspace &&
        previous.model === state.model &&
        previous.quote === quote &&
        previous.observe === !addressed
      const source = {
        update: update.id,
        message: update.message!.message_id,
        text: observedVoice ? update.text + "\n[Voice message]" : update.text,
        date: update.message!.date ?? 0,
      }
      const ready = now + (media ? 0 : binding.input_debounce_seconds * 1000)
      const batch: TelegramBatch = batchable
        ? { ...previous, ready, sources: [...previous.sources, source] }
        : {
            id: key(id, connection, update.id, "input"),
            route,
            target,
            requester: update.requester,
            speaker: speaker.public_id,
            sources: [source],
            ready,
            ...(state.model ? { model: state.model } : {}),
            ...(quote ? { quote } : {}),
            observe: !addressed,
            ...(media ? { media } : {}),
          }
      return {
        ...state,
        consumed: { ...state.consumed, [connection]: update.id },
        batches: batchable ? [...state.batches.slice(0, -1), batch] : [...state.batches, batch],
      }
    })
    if (!bot.current && bot.settings.welcome_message)
      await document.change((state) => ({
        ...state!,
        deliveries: enqueue(state!.deliveries, {
          id: key(id, target.conversation, "welcome"),
          route,
          text: bot.settings.welcome_message!,
          kind: "notice",
          status: "pending",
        }),
      }))
  }

  async tick(connection: string, now = Date.now()) {
    for (const [id, binding] of Object.entries(this.settings.bots).filter(
      ([, row]) => row.enabled && row.connection_public_id === connection,
    )) {
      const document = this.state(id)
      await document.change((state) => {
        const current = state ?? telegramState()
        const retired = current.deliveries.filter(
          (row) =>
            row.status === "sent" &&
            (row.kind === "participation"
              ? current.participation?.candidate?.id !== row.id
              : !["question", "approval"].includes(row.kind) ||
                current.work.some((work) => work.input === row.input && work.terminal)),
        )
        if (!retired.length) return current
        return {
          ...current,
          deliveries: current.deliveries.filter((row) => !retired.includes(row)),
          messages: [
            ...(current.messages ?? []),
            ...retired
              .filter((row) => row.message !== undefined && (row.input || row.kind === "participation"))
              .map((row) => ({
                id: row.id,
                route: row.route,
                requester: row.requester,
                target: row.target,
                input: row.input,
                kind: row.kind,
                status: "sent" as const,
                message: row.message,
                text: "",
              })),
          ],
        }
      })
      await telegramJobDiscovery(document, this.application(), id, this.signal)
      const state = (await document.read()) ?? telegramState()
      for (const job of state.jobs ?? []) {
        const executions = await this.application()
          .client.workspace(job.target.workspace)
          .conversation(job.target.conversation)
          .schedules.executions(job.id, {}, { signal: this.signal })
        for (const execution of executions.items.filter((row) => row.input_public_id)) {
          await document.change((state) => ({
            ...state!,
            work: state!.work.some((row) => row.input === execution.input_public_id)
              ? state!.work
              : [
                  ...state!.work,
                  {
                    id: key(job.id, execution.input_public_id!),
                    route: job.route,
                    target: { workspace: job.target.workspace, conversation: execution.child_conversation_public_id },
                    requester: job.requester,
                    speaker: job.speaker,
                    source: [],
                    input: execution.input_public_id!,
                    voice: false,
                  },
                ],
          }))
        }
      }
      const head = state.batches[0]
      if (head && head.ready <= now) await this.admit(id, binding, document, head, now)
      await telegramCandidates(document, this.application(), this.signal)
      for (const work of ((await document.read()) ?? telegramState()).work.filter(
        (row) => !row.terminal && !row.worker,
      ))
        await this.follow(id, binding, document, work)
      await telegramWorkers(document, this.application(), this.signal, (work, answerer) =>
        this.bindDestination(id, document, work, answerer),
      )
      for (const work of ((await document.read()) ?? telegramState()).work.filter((row) => row.worker && !row.terminal))
        await this.follow(id, binding, document, work)
      await telegramParticipate(document, binding, this.application(), id, now, this.signal)
      for (const delivery of ((await document.read()) ?? telegramState()).deliveries.filter(
        (row) =>
          row.status !== "sent" &&
          row.status !== "refused" &&
          row.status !== "uncertain" &&
          (!row.retry || row.retry <= now),
      ))
        await this.deliver(document, delivery, now, id)
    }
    await this.progress.flush(connection, now)
  }

  private application() {
    return this.options.application()
  }

  async binding(workspace: string, conversation: string) {
    for (const [id, binding] of Object.entries(this.settings.bots)) {
      const state = await this.state(id).read()
      const work = state?.work.find(
        (work) => work.target.workspace === workspace && work.target.conversation === conversation,
      )
      if (work)
        return {
          source: "telegram",
          bot: id,
          connection: work.route.connection,
          chat: work.route.chat,
          topic: work.route.topic,
          read_only: true,
        }
      if (!binding.connection_public_id || !binding.target) continue
      const bot = Schema.decodeUnknownSync(Bot)(await this.application().bots.command({ action: "bot.read", id }))
      if (bot.current?.public_id === conversation && bot.current.workspace_public_id === workspace)
        return {
          source: "telegram",
          bot: id,
          connection: binding.connection_public_id,
          chat: binding.target.chat_id,
          topic: binding.target.topic_id,
          read_only: true,
        }
    }
  }

  private async bindDestination(bot: string, document: StateDocument, work: TelegramWork, answerer: string) {
    if (work.answerer) return
    const binding = this.settings.bots[answerer]
    const connected = binding?.connection_public_id
      ? this.settings.connections[binding.connection_public_id]
      : undefined
    const destination = binding && answerer !== bot ? await this.state(answerer).read() : null
    const known =
      destination &&
      [
        ...destination.work.map((row) => row.route),
        ...destination.batches.map((row) => row.route),
        ...destination.deliveries.map((row) => row.route),
      ].find(
        (route) =>
          route.connection === binding.connection_public_id &&
          route.chat === work.route.chat &&
          route.topic === work.route.topic &&
          route.group === work.route.group,
      )
    const configured = answerer !== bot && binding?.connection_public_id && binding.target
    const identity = configured ? (await this.connection(binding.connection_public_id!).read())?.identity : undefined
    const audience = configured
      ? Schema.decodeUnknownSync(Bot)(await this.application().bots.command({ action: "bot.read", id: answerer }))
          .settings.audience
      : undefined
    const available =
      configured &&
      (audience === "external" || (work.requester === binding.owner_id && !work.route.group)) &&
      binding.enabled &&
      connected?.enabled &&
      connected.token &&
      identity &&
      known &&
      destination &&
      permitted(binding, destination, work.requester, known.group, known.chat)
    const route = available ? { ...known, destination_bot: answerer, destination_owner: work.requester } : undefined
    const error = configured && !available ? "destination_unavailable" : undefined
    await document.change((state) => ({
      ...state!,
      work: state!.work.map((row) =>
        row.id === work.id
          ? { ...row, answerer, ...(route ? { result_route: route } : {}), ...(error ? { delivery_error: error } : {}) }
          : row,
      ),
      deliveries: error
        ? enqueue(state!.deliveries, {
            id: key(work.id, "destination-unavailable"),
            route: work.route,
            requester: work.requester,
            text: "The worker's Bot has no available Telegram connection for this requester and chat/topic. Its parent report remains in the source chat.",
            kind: "notice",
            status: "pending",
          })
        : state!.deliveries,
    }))
  }
  private connection(id: string) {
    const document =
      this.connections.get(id) ??
      new StoreDocument(
        this.application().client.profile.storeEntries,
        "opencode.telegram.connection",
        id,
        Schema.decodeUnknownSync(TelegramConnectionState),
      )
    this.connections.set(id, document)
    return document
  }
  private state(id: string) {
    const document =
      this.states.get(id) ??
      new StoreDocument(
        this.application().client.profile.storeEntries,
        "opencode.telegram.bot",
        id,
        Schema.decodeUnknownSync(TelegramState),
      )
    this.states.set(id, document)
    return document
  }
  private api(id: string) {
    const connection = this.settings.connections[id]
    if (!connection) throw new Error("Unknown Telegram Connection.")
    const client = this.clients.get(id) ?? new TelegramAPI(connection.token, this.signal, this.options.origin)
    this.clients.set(id, client)
    return client
  }

  private transport(id: string) {
    const transport = this.transports.get(id) ?? new TelegramTransport(this.api(id), this.connection(id))
    this.transports.set(id, transport)
    return transport
  }

  private async admit(
    id: string,
    binding: TelegramBinding,
    document: StateDocument,
    batch: TelegramBatch,
    now: number,
  ) {
    const state = (await document.read())!
    if (!batch.submission && !permitted(binding, state, batch.requester, batch.route.group, batch.route.chat)) {
      await document.change((state) => ({ ...state!, batches: state!.batches.filter((row) => row.id !== batch.id) }))
      return
    }
    const update = async (fields: Partial<TelegramBatch>) => {
      const saved = await document.change((state) => ({
        ...state!,
        batches: state!.batches.map((row) => (row.id === batch.id ? { ...row, ...fields } : row)),
      }))
      batch = saved.batches.find((row) => row.id === batch.id)!
    }
    try {
      if (now / 1000 - batch.sources[0].date >= 86399)
        throw new TelegramRefusal(
          "The admission receipt expired. Check the original conversation before sending this request again.",
        )
      if (batch.media && !batch.upload) {
        const info = Schema.decodeUnknownSync(File)(
          await this.api(batch.route.connection).call("getFile", { file_id: batch.media.file_id }),
        )
        if (Math.max(info.file_size ?? 0, batch.media.file_size ?? 0) > 20 * 1024 * 1024)
          throw new TelegramRefusal("Telegram media downloads are limited to 20 MiB.")
        const bytes = await this.api(batch.route.connection).download(info.file_path)
        const upload = await this.application().client.uploads.create(
          new Blob([bytes], { type: batch.media.content_type }),
          batch.media.filename,
          { signal: this.signal },
        )
        await update({ upload: upload.public_id })
      }
      if (batch.media?.kind === "voice" && batch.transcript === undefined) {
        if (!binding.transcription_model)
          throw new TelegramRefusal("Select a transcription model for this Telegram Bot before sending voice messages.")
        const lane = this.application().client.workspace(batch.target.workspace).inferenceRequests
        const inference = batch.inference
          ? await lane.fetch(batch.inference, { signal: this.signal })
          : (
              await lane.create(
                {
                  workload: "transcription",
                  model: { model: binding.transcription_model },
                  input: null,
                  upload_public_ids: [batch.upload!],
                },
                { idempotencyKey: batch.id + ":transcription", signal: this.signal },
              )
            ).inference_request
        await update({ inference: inference.public_id })
        if (["failed", "canceled"].includes(inference.status))
          throw new TelegramRefusal("Voice transcription did not complete. Please resend the message or type it.")
        if (inference.status !== "completed") return
        if (!inference.result?.output_text?.trim())
          throw new TelegramRefusal("No speech was recognized. Please resend the message or type it.")
        await update({ transcript: inference.result.output_text.trim() })
      }
      if (!batch.submission) {
        const text = [
          batch.quote ? "Quoted Bot reply:\n" + batch.quote : "",
          ...batch.sources.map((row) => row.text),
          batch.transcript ?? "",
        ]
          .filter(Boolean)
          .join("\n\n")
        const submission = {
          action: "bot.submit" as const,
          id,
          ...batch.target,
          key: batch.id,
          text,
          speaker: batch.speaker,
          ...(batch.model ? { model: batch.model } : {}),
          ...(batch.upload && batch.media?.kind !== "voice" ? { attachments: [batch.upload] } : {}),
          delivery: "queue" as const,
          observe: batch.observe,
        }
        await update({ submission })
      }
      const policy = await this.application().bots.capture(batch.submission!)
      const receipt = await this.application().bots.submit(batch.submission!)
      await document.change((state) => ({
        ...state!,
        ...(batch.observe && batch.route.group
          ? {
              participation: {
                after: state!.participation?.after ?? 0,
                last_attempt: state!.participation?.last_attempt ?? 0,
                last_sent: state!.participation?.last_sent ?? 0,
                ...(state!.participation?.candidate ? { candidate: state!.participation.candidate } : {}),
                source: {
                  update: batch.sources.at(-1)!.update,
                  at: now,
                  input: receipt.input.public_id,
                  requester: batch.requester,
                  speaker: batch.speaker,
                  route: batch.route,
                  target: batch.target,
                  model: policy.model!.model,
                },
              },
            }
          : {}),
        batches: state!.batches.filter((row) => row.id !== batch.id),
        work: state!.work.some((row) => row.input === receipt.input.public_id)
          ? state!.work
          : [
              ...state!.work,
              {
                id: batch.id,
                route: batch.route,
                target: batch.target,
                requester: batch.requester,
                speaker: batch.speaker,
                source: batch.sources.map((row) => row.message),
                input: receipt.input.public_id,
                voice: batch.media?.kind === "voice",
                ...(batch.observe ? { terminal: true } : {}),
              },
            ],
      }))
    } catch (error) {
      if (
        !(error instanceof TelegramRefusal) &&
        !(error instanceof APIError && error.status !== 429 && error.status < 500) &&
        !(error instanceof TelegramError && error.code !== 429 && error.code < 500)
      )
        throw error
      await document.change((state) => ({
        ...state!,
        batches: state!.batches.filter((row) => row.id !== batch.id),
        deliveries: enqueue(state!.deliveries, {
          id: key(batch.id, "refused"),
          route: batch.route,
          requester: batch.requester,
          text:
            error instanceof TelegramRefusal
              ? error.message
              : "Request not accepted: " + (error instanceof APIError ? error.status : error.code) + ".",
          kind: "notice",
          status: "pending",
        }),
      }))
    }
  }

  private async follow(id: string, binding: TelegramBinding, document: StateDocument, work: TelegramWork) {
    const execution = telegramExecution(this.application(), work)
    const snapshot = await execution.recover({ signal: this.signal }).then(executionSnapshot)
    if (snapshot) {
      const run =
        snapshot.execution.run_public_id && !snapshot.terminal
          ? await this.application()
              .client.workspace(work.target.workspace)
              .run(snapshot.execution.run_public_id)
              .fetch({ signal: this.signal })
          : undefined
      this.progress.observe(document, work, snapshot, run || undefined)
    }
    if (snapshot && JSON.stringify(work.execution) !== JSON.stringify(snapshot.execution))
      await document.change((state) => ({
        ...state!,
        work: state!.work.map((row) => (row.id === work.id ? { ...row, execution: snapshot.execution } : row)),
      }))
    if (snapshot?.terminal || execution.blocked_reason) {
      if (work.worker) return
      if (work.candidate && snapshot) {
        const turn = await this.application()
          .client.workspace(work.target.workspace)
          .conversation(work.target.conversation)
          .turns.fetch(snapshot.execution.turn_public_id, { include_hidden: true }, { signal: this.signal })
        if (turn.active_variant?.public_id !== snapshot.execution.variant_public_id && snapshot.status === "completed")
          return
      }
      const text = snapshot?.content || execution.blocked_reason || snapshot?.failure_reason || "Reply finished."
      const artifacts =
        snapshot?.status === "completed"
          ? await publishedArtifacts(
              this.application().client,
              work.target.workspace,
              { run: snapshot.execution.run_public_id },
              this.signal,
            )
          : []
      const source = snapshot?.execution.variant_public_id
        ? { turn: snapshot.execution.turn_public_id, variant: snapshot.execution.variant_public_id, canonical: false }
        : undefined
      await document.change((state) => {
        const deliveries = telegramRender(text).reduce(
          (rows, chunk, index) =>
            enqueue(rows, {
              id: key(work.id, "answer", index),
              route: work.result_route ?? work.route,
              requester: work.requester,
              target: work.target,
              input: work.input,
              ...chunk,
              ...(source ? { execution: source } : {}),
              kind: "answer",
              status: "pending",
            }),
          [...state!.deliveries],
        )
        const spoken = binding.speech_model && (state!.voice === "all" || (state!.voice === "voice_only" && work.voice))
        const files = artifacts.reduce(
          (rows, upload) =>
            enqueue(rows, {
              id: key(work.id, "file", upload.public_id),
              route: work.result_route ?? work.route,
              requester: work.requester,
              target: work.target,
              input: work.input,
              text: "",
              kind: "file",
              ...(source ? { execution: source } : {}),
              status: "pending",
              upload,
            }),
          deliveries,
        )
        return {
          ...state!,
          work: state!.work.map((row) => (row.id === work.id ? { ...row, terminal: true } : row)),
          deliveries: spoken
            ? telegramChunks(text, 600).reduce(
                (rows, text, index) =>
                  enqueue(rows, {
                    id: key(work.id, "voice", index),
                    route: work.result_route ?? work.route,
                    requester: work.requester,
                    target: work.target,
                    input: work.input,
                    text,
                    kind: "voice",
                    ...(source ? { execution: source } : {}),
                    status: "preparing",
                    model: binding.speech_model,
                  }),
                files,
              )
            : files,
        }
      })
      await this.application().notify("telegram.reply", {
        bot: id,
        workspace: work.target.workspace,
        conversation: work.target.conversation,
        input: work.input,
      })
      return
    }
    for (const decision of await execution.decisions({ signal: this.signal })) {
      const task = decision.detail.task.key
      await document.change((state) => ({
        ...state!,
        deliveries: enqueue(state!.deliveries, {
          id: key(work.id, "decision", task),
          route: work.route,
          requester: work.requester,
          target: work.target,
          input: work.input,
          task,
          text:
            decision.kind === "approval"
              ? "Approve " +
                decision.detail.task.tool_name +
                "?\n" +
                JSON.stringify(decision.detail.tool_input).slice(0, 3000) +
                "\nReply /approve or /deny."
              : "Question (" +
                key(work.id, "decision", task).slice(0, 12) +
                ")\n" +
                (decision.detail.prompt ?? "Answer requested") +
                "\nReply /answer followed by your answer.",
          kind: decision.kind === "approval" ? "approval" : "question",
          status: "pending",
        }),
      }))
    }
  }

  private async deliver(document: StateDocument, initial: TelegramDelivery, now: number, bot: string) {
    let delivery = initial
    const save = async (fields: Partial<TelegramDelivery>) => {
      const state = await document.change((state) => ({
        ...state!,
        deliveries: state!.deliveries.map((row) => (row.id === delivery.id ? { ...row, ...fields } : row)),
      }))
      delivery = state.deliveries.find((row) => row.id === delivery.id)!
    }
    if (
      !this.settings.connections[delivery.route.connection]?.enabled ||
      !this.settings.connections[delivery.route.connection]?.token
    ) {
      if (delivery.route.destination_bot) await save({ status: "refused", error: "destination_unavailable" })
      return
    }
    const source = (await document.read())!
    const request = source.work.find((work) => work.input === delivery.input)
    const original = request?.route ?? delivery.route
    const reply =
      request?.source[0] && !delivery.route.destination_bot && sameRoute(original, delivery.route)
        ? { message_id: request.source[0], allow_sending_without_reply: true }
        : undefined
    const binding = this.settings.bots[bot]
    const allowed =
      (!original.group || source.access.allowed_chats.includes(original.chat)) &&
      (!delivery.route.group ||
        delivery.route.destination_bot ||
        source.access.allowed_chats.includes(delivery.route.chat))
    if (
      !allowed ||
      (!delivery.route.group &&
        !delivery.route.destination_bot &&
        delivery.route.chat !== binding.owner_id &&
        delivery.route.chat !== original.chat)
    ) {
      await save({ status: "refused", error: "destination_unavailable" })
      return
    }
    if (delivery.route.destination_bot) {
      const peer = this.settings.bots[delivery.route.destination_bot]
      const state = peer ? await this.state(delivery.route.destination_bot).read() : null
      const identity = peer?.connection_public_id
        ? (await this.connection(peer.connection_public_id).read())?.identity
        : null
      const audience = peer
        ? Schema.decodeUnknownSync(Bot)(
            await this.application().bots.command({ action: "bot.read", id: delivery.route.destination_bot }),
          ).settings.audience
        : undefined
      if (
        !peer?.enabled ||
        (audience !== "external" && (delivery.route.group || delivery.route.destination_owner !== peer.owner_id)) ||
        peer.connection_public_id !== delivery.route.connection ||
        !state ||
        !identity ||
        !permitted(peer, state, delivery.route.destination_owner!, delivery.route.group, delivery.route.chat)
      ) {
        await save({ status: "refused", error: "destination_unavailable" })
        return
      }
    }
    if (delivery.status === "sending") {
      await save({ status: "uncertain" })
      return
    }
    if (delivery.execution && delivery.target) {
      const captured = delivery.execution
      const turns = this.application()
        .client.workspace(delivery.target.workspace)
        .conversation(delivery.target.conversation).turns
      const current = await (async () => {
        const variant = captured.canonical
          ? (await turns.variant(captured.turn, captured.variant, { signal: this.signal })).variant
          : (await turns.fetch(captured.turn, { include_hidden: true }, { signal: this.signal })).active_variant
        return (
          variant?.public_id === captured.variant &&
          !variant.details_pruned_at &&
          (captured.canonical ? variant.status === "completed" : !["pending", "running"].includes(variant.status))
        )
      })().catch((error: unknown) => {
        if (error instanceof APIError && [403, 404, 410].includes(error.status)) return false
        throw error
      })
      if (!current) {
        await save({ status: "refused", error: "source_unavailable" })
        if (delivery.inference)
          await this.application()
            .client.workspace(delivery.target.workspace)
            .inferenceRequests.cancel(delivery.inference, { signal: this.signal })
            .catch(() => {})
        return
      }
    }
    if (delivery.kind === "voice" && delivery.status === "preparing") {
      const preceding = (await document.read())!.deliveries.filter(
        (row) => row.kind === "voice" && row.input === delivery.input,
      )
      if (
        preceding
          .slice(
            0,
            preceding.findIndex((row) => row.id === delivery.id),
          )
          .some((row) => row.status !== "sent")
      )
        return
      const lane = this.application().client.workspace(delivery.target!.workspace).inferenceRequests
      const inference = delivery.inference
        ? await lane.fetch(delivery.inference, { signal: this.signal })
        : (
            await lane.create(
              { workload: "speech_generation", model: { model: delivery.model! }, input: delivery.text },
              { idempotencyKey: delivery.id, signal: this.signal },
            )
          ).inference_request
      await save({ inference: inference.public_id })
      if (
        ["failed", "canceled"].includes(inference.status) ||
        (inference.status === "completed" && !inference.result?.output_files?.length)
      ) {
        await save({ status: "refused" })
        return
      }
      if (inference.status !== "completed") return
      await save({ status: "pending", index: inference.result!.output_files![0].index })
    }
    if (delivery.upload && delivery.upload.byte_size > 50 * 1024 * 1024) {
      await save({ status: "refused", error: "media_too_large" })
      await document.change((state) => ({
        ...state!,
        deliveries: enqueue(state!.deliveries, {
          id: key(delivery.id, "media-limit"),
          route: delivery.route,
          text: "This attachment exceeds Telegram's 50 MiB upload limit. The text reply is still available.",
          kind: "notice",
          status: "pending",
        }),
      }))
      return
    }
    const method = delivery.document
      ? "sendDocument"
      : delivery.kind === "voice"
        ? "sendVoice"
        : delivery.kind === "file"
          ? delivery.upload?.content_type.startsWith("image/") && delivery.upload.byte_size <= 10 * 1024 * 1024
            ? "sendPhoto"
            : "sendDocument"
          : "sendMessage"
    let sending = false
    try {
      const body =
        delivery.kind === "voice" || delivery.kind === "file"
          ? await (async () => {
              const download = delivery.upload
                ? await this.application().client.uploads.bytes(delivery.upload.public_id, { signal: this.signal })
                : await this.application()
                    .client.workspace(delivery.target!.workspace)
                    .inferenceRequests.download(delivery.inference!, delivery.index!, { signal: this.signal })
              const form = new FormData()
              form.set("chat_id", delivery.route.chat)
              if (delivery.route.topic) form.set("message_thread_id", String(delivery.route.topic))
              if (reply) form.set("reply_parameters", JSON.stringify(reply))
              form.set(
                method === "sendPhoto" ? "photo" : method === "sendVoice" ? "voice" : "document",
                new Blob([await telegramBytes(new Response(download.body), 50 * 1024 * 1024)], {
                  type: delivery.upload?.content_type ?? "audio/ogg",
                }),
                delivery.upload?.filename ?? "reply.ogg",
              )
              return form
            })()
          : {
              chat_id: delivery.route.chat,
              ...(delivery.route.topic ? { message_thread_id: delivery.route.topic } : {}),
              ...(reply ? { reply_parameters: reply } : {}),
              text: delivery.html && !delivery.plain ? delivery.html : delivery.text,
              ...(delivery.html && !delivery.plain ? { parse_mode: "HTML" } : {}),
              ...(delivery.kind === "approval"
                ? {
                    reply_markup: {
                      inline_keyboard: [
                        [
                          { text: "Approve once", callback_data: "approve:" + delivery.id },
                          { text: "Deny", callback_data: "deny:" + delivery.id },
                        ],
                      ],
                    },
                  }
                : {}),
            }
      const sent = await this.transport(delivery.route.connection).send(delivery.route, now, async (api) => {
        await save({ status: "sending" })
        sending = true
        return Schema.decodeUnknownSync(Sent)(await api.call(method, body))
      })
      if (sent) await save({ status: "sent", message: sent.message_id })
    } catch (error) {
      if (this.signal.aborted) throw error
      await save(
        error instanceof TelegramError && error.retryAfter
          ? { status: "pending", retry: now + error.retryAfter * 1000 }
          : error instanceof TelegramError && error.code === 400 && ["sendPhoto", "sendVoice"].includes(method)
            ? { status: "pending", document: true }
            : error instanceof TelegramError && error.code === 400 && delivery.html && !delivery.plain
              ? { status: "pending", plain: true }
              : error instanceof TelegramError && error.code >= 500
                ? { status: "pending", retry: now + 10000 }
                : error instanceof TelegramError
                  ? { status: "refused" }
                  : sending || error instanceof TelegramUncertain
                    ? { status: "uncertain" }
                    : error instanceof TransportError ||
                        (error instanceof APIError && (error.status === 429 || error.status >= 500))
                      ? { status: "pending", retry: now + 3000 }
                      : { status: "refused" },
      )
    }
  }

  private async control(
    id: string,
    binding: TelegramBinding,
    bot: typeof Bot.Type,
    state: TelegramState,
    update: TelegramUpdate,
    action: string,
    argument: string,
    reply: TelegramDelivery | undefined,
    now: number,
  ) {
    const document = this.state(id)
    const owner = binding.owner_id === update.requester
    const keyValue = key(id, update.id, action)
    if (action === "settings")
      return (
        "Mode: " +
        (state.mode ?? "assistant") +
        "; observe: " +
        (state.observe ? "on" : "off") +
        "; voice: " +
        state.voice +
        "; model: " +
        (state.model ?? "Bot preset default") +
        "; new-message age limit: " +
        binding.stale_after +
        " seconds."
      )
    if (action === "observe" && (!argument || argument === "status"))
      return (
        "Observation is " + (state.observe ? "on" : "off") + " for " + update.chat + ":" + (update.topic ?? 0) + "."
      )
    if (action === "mode" && (!argument || argument === "status"))
      return (
        "Mode: " +
        (state.mode ?? "assistant") +
        (state.observe ? "." : "; observation is off, so active participation is paused.")
      )
    if (action === "model" && !argument)
      return (
        "Available models:\n" +
        (await this.application().client.models.list({ workload: "text_generation" }, { signal: this.signal }))
          .map((row) => row.ref)
          .join("\n") +
        "\nUse /model provider/model."
      )
    if (action === "workspace" && argument === "current")
      return "Current workspace: " + (bot.current?.workspace_public_id ?? "none") + "."
    if (["side", "btw"].includes(action))
      return "Side conversations are not available in Telegram. Continue in this chat or use /new."
    if (action === "whoami")
      return "User " + update.requester + "; chat " + update.chat + "; topic " + (update.topic ?? "none") + "."
    if (["help", "start"].includes(action)) return telegramHelp
    if (action === "status" && argument) {
      const work = state.work.find((row) => row.input === argument)
      if (!work || (!owner && work.requester !== update.requester)) return "Unknown or unavailable task ID."
      const execution = telegramExecution(this.application(), work)
      const snapshot = await execution.recover({ signal: this.signal }).then(executionSnapshot)
      return (
        "Task " +
        work.input +
        "\nConversation " +
        work.target.conversation +
        "\n" +
        (snapshot?.status ?? execution.blocked_reason ?? "Waiting for materialization")
      )
    }
    if (action === "status")
      return (
        "Current conversation: " +
        (bot.current?.public_id ?? "none") +
        ". Pending sources: " +
        state.batches.length +
        ". Active work: " +
        state.work.filter((row) => !row.terminal).length +
        "."
      )
    if (action === "destinations") {
      if (!owner) return "Only the Bot owner can manage result destinations."
      return (
        [
          ...new Set(
            state.work
              .flatMap((row) => [row.route, ...(row.result_route ? [row.result_route] : [])])
              .filter(
                (route) =>
                  route.connection === binding.connection_public_id &&
                  (!route.group || state.access.allowed_chats.includes(route.chat)),
              )
              .map((route) => route.chat + ":" + (route.topic ?? 0)),
          ),
        ].join("\n") || "No admitted destinations are known."
      )
    }
    if (action === "deliver") {
      if (!owner) return "Only the Bot owner can manage result destinations."
      const [input, destination] = argument.split(/\s+/)
      const work = state.work.find((row) => row.input === input)
      const route = state.work
        .flatMap((row) => [row.route, ...(row.result_route ? [row.result_route] : [])])
        .find(
          (route) =>
            route.chat + ":" + (route.topic ?? 0) === destination &&
            route.connection === binding.connection_public_id &&
            (!route.group || state.access.allowed_chats.includes(route.chat)),
        )
      if (!work || !route) return "Use /deliver TASK_ID with an exact destination from /destinations."
      if (work.report)
        return "Parent reports retain their original destination. Select the independent worker's task ID to export its own result."
      const snapshot = await telegramExecution(this.application(), work)
        .recover({ signal: this.signal })
        .then(executionSnapshot)
      const files =
        snapshot?.status === "completed"
          ? await publishedArtifacts(
              this.application().client,
              work.target.workspace,
              { run: snapshot.execution.run_public_id },
              this.signal,
            )
          : []
      const copies: TelegramDelivery[] =
        snapshot?.status === "completed"
          ? [
              ...telegramRender(snapshot.content ?? "").map(
                (chunk, index): TelegramDelivery => ({
                  id: key(work.id, snapshot.execution.variant_public_id ?? "", destination, "text", index),
                  route,
                  target: work.target,
                  requester: work.requester,
                  input: work.input,
                  ...chunk,
                  execution: {
                    turn: snapshot.execution.turn_public_id,
                    variant: snapshot.execution.variant_public_id!,
                    canonical: !!work.worker,
                  },
                  kind: "answer",
                  status: "pending",
                }),
              ),
              ...files.map(
                (upload): TelegramDelivery => ({
                  id: key(work.id, snapshot.execution.variant_public_id ?? "", destination, upload.public_id),
                  route,
                  target: work.target,
                  requester: work.requester,
                  input: work.input,
                  text: "",
                  upload,
                  execution: {
                    turn: snapshot.execution.turn_public_id,
                    variant: snapshot.execution.variant_public_id!,
                    canonical: !!work.worker,
                  },
                  kind: "file",
                  status: "pending",
                }),
              ),
            ]
          : []
      await document.change((state) => ({
        ...state!,
        work: state!.work.map((row) => (row.input === input ? { ...row, result_route: route } : row)),
        deliveries: copies
          .filter((copy) => !state!.messages?.some((message) => message.id === copy.id))
          .reduce((rows, delivery) => enqueue(rows, delivery), [...state!.deliveries]),
      }))
      return "Future task results will use " + destination + ". The latest completed result was queued there once."
    }
    if (action === "tasks")
      return (
        state.work
          .filter((row) => !row.terminal && (owner || row.requester === update.requester))
          .map((row) => row.input + " · " + row.target.conversation)
          .join("\n") || "No active requests."
      )
    if (action === "queue") {
      if (!bot.current) return "No conversation is open."
      const chat = this.application()
        .client.workspace(bot.current.workspace_public_id)
        .conversation(bot.current.public_id)
      const page = await chat.inputs.list({ signal: this.signal })
      const allowed = page.items.filter(
        (input) =>
          owner || state.work.some((work) => work.input === input.public_id && work.requester === update.requester),
      )
      if (!argument) {
        await document.change((state) => ({
          ...state!,
          queue: { ...state!.queue, [update.requester]: allowed.map((row) => row.public_id) },
        }))
        return (
          allowed
            .map(
              (row, index) => String(index + 1) + ". " + row.public_id + " · " + row.state + " · " + (row.text ?? ""),
            )
            .join("\n") || "No waiting inputs."
        )
      }
      const match = /^(edit|cancel|reschedule)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(argument)
      if (!match)
        return "Use /queue, /queue edit N TEXT, /queue cancel N, or /queue reschedule N in DURATION|at TIME|now."
      const selected = allowed.find((row) => row.public_id === state.queue?.[update.requester]?.[Number(match[2]) - 1])
      if (!selected) return "Refresh /queue before selecting a waiting input."
      if (match[1] === "cancel") {
        await chat.inputs.delete(selected.public_id, { signal: this.signal })
        return "Waiting input canceled."
      }
      await chat.inputs.update(
        selected.public_id,
        {
          expected_lock_version: selected.lock_version,
          ...(match[1] === "edit" ? { text: match[3] ?? "" } : { deliver_at: telegramTime(match[3] ?? "", now) }),
        },
        { signal: this.signal },
      )
      return "Waiting input updated."
    }
    if (action === "job" || action === "remind") {
      if (update.media || update.unsupportedMedia) return "/job and /remind accept text only."
      const job = action === "job" ? argument.split(/\s+/) : []
      const trackedJob =
        job[1] && !["create", "list"].includes(job[0])
          ? state.jobs?.find(
              (row) =>
                row.id === job[1] &&
                sameRoute(row.route, {
                  connection: binding.connection_public_id!,
                  chat: update.chat,
                  topic: update.topic,
                  group: update.group,
                }),
            )
          : undefined
      if (
        job[1] &&
        !["create", "list"].includes(job[0]) &&
        (!trackedJob || (!owner && trackedJob.requester !== update.requester))
      )
        return "That scheduled job is not available to you in this chat/topic. Use /job list."
      if (!bot.current && !trackedJob && !state.control?.job) return "Send a message to open a conversation first."
      const speaker = await this.application().client.profile.registerIngressSpeaker(
        {
          channel_key: "telegram:" + id,
          external_id: update.requester,
          display_name: update.user?.first_name ?? update.requester,
        },
        { signal: this.signal },
      )
      const target = trackedJob?.target ??
        state.control?.job?.target ?? {
          workspace: bot.current!.workspace_public_id,
          conversation: bot.current!.public_id,
        }
      const route = {
        connection: binding.connection_public_id!,
        chat: update.chat,
        topic: update.topic,
        group: update.group,
      }
      if (action === "remind") {
        const match = /^(in|at)\s+(\S+)\s+([\s\S]+)$/.exec(argument)
        if (!match || update.media)
          return "Use /remind in DURATION TEXT or /remind at TIME TEXT. Reminders accept text only."
        const submission = {
          action: "bot.submit" as const,
          id,
          ...target,
          key: keyValue,
          text: "Please remind me now: " + match[3],
          speaker: speaker.public_id,
          delivery: "queue" as const,
          deliver_at: telegramTime(match[1] + " " + match[2], now),
          ...(state.model ? { model: state.model } : {}),
        }
        await document.change((state) => ({
          ...state!,
          batches: state!.batches.some((row) => row.id === keyValue)
            ? state!.batches
            : [
                ...state!.batches,
                {
                  id: keyValue,
                  route,
                  target,
                  requester: update.requester,
                  speaker: speaker.public_id,
                  sources: [
                    {
                      update: update.id,
                      message: update.message!.message_id,
                      text: submission.text,
                      date: update.message!.date ?? Math.floor(now / 1000),
                    },
                  ],
                  ready: now,
                  observe: false,
                  submission,
                },
              ],
        }))
        return "Reminder queued for " + submission.deliver_at + "."
      }
      const result = await telegramJob(argument, {
        application: this.application(),
        bot: id,
        ...target,
        speaker: speaker.public_id,
        owner: owner || (!!trackedJob && trackedJob.requester === update.requester) || job[0] === "create",
        key: keyValue,
        now,
        signal: this.signal,
        model: state.control?.job ? (state.control.job.model ?? undefined) : state.model,
      })
      if (result.schedule)
        await document.change((state) => ({
          ...state!,
          jobs: (state!.jobs ?? []).some((row) => row.id === result.schedule)
            ? state!.jobs
            : [
                ...(state!.jobs ?? []),
                { id: result.schedule!, route, target, requester: update.requester, speaker: speaker.public_id },
              ],
        }))
      return result.text
    }
    if (["steer", "task", "transcript"].includes(action)) {
      const words = argument.split(/\s+/).filter(Boolean)
      const operation = action === "task" ? words.shift() : undefined
      const named =
        words[0] && (state.work.some((work) => work.input === words[0]) || /^[0-9a-f-]{32,36}$/.test(words[0]))
          ? words.shift()
          : undefined
      const work = named
        ? state.work.find((row) => row.input === named)
        : reply?.input
          ? state.work.find((row) => row.input === reply.input)
          : state.work.findLast((row) => row.requester === update.requester)
      if (!work || (!owner && work.requester !== update.requester))
        return "Unknown or unavailable task. Reply to your request or supply its task ID."
      const scope = this.application().client.workspace(work.target.workspace)
      const chat = scope.conversation(work.target.conversation)
      const snapshot = await telegramExecution(this.application(), work)
        .recover({ signal: this.signal })
        .then(executionSnapshot)
      const run = snapshot?.execution.run_public_id
      if (!run) return "This task has not started. Use /queue for waiting requests."
      if (action === "transcript") {
        const query: { prefix?: string; before?: string } = {}
        for (let index = 0; index < words.length; index += 2) {
          if (words[index] === "branch") query.prefix = words[index + 1]
          else if (words[index] === "before") query.before = words[index + 1]
          else return "Use /transcript [TASK_ID] [branch PREFIX] [before CURSOR]."
        }
        return JSON.stringify(await scope.run(run).transcript(query, { signal: this.signal }), null, 2)
      }
      if (action === "steer") {
        if (snapshot.terminal || !words.length) return "Steer needs instruction text and an active original execution."
        await chat.inputs.create(
          {
            kind: "direct_reply",
            text: words.join(" "),
            speaker_public_id: work.speaker,
            delivery_mode: "steer",
            expected_steering_run_public_id: run,
          },
          { idempotencyKey: keyValue, signal: this.signal },
        )
        return "Steering submitted to the original execution."
      }
      if (operation === "pause") await scope.run(run).pause(false, { signal: this.signal })
      else if (operation === "resume") await scope.run(run).resume({ signal: this.signal })
      else if (operation === "retry" || operation === "abandon") {
        const detail = await scope.run(run).fetch({ signal: this.signal })
        const task =
          words[0] ?? detail.tasks.findLast((row) => ["failed", "timed_out", "uncertain"].includes(row.status))?.key
        if (!task) return "Supply the failed task key after the task ID."
        if (operation === "retry") await scope.run(run).task(task).retry(undefined, { signal: this.signal })
        else await scope.run(run).task(task).abandon({ signal: this.signal })
      } else return "Use /task pause|resume|retry|abandon [TASK_ID] [TASK_KEY]."
      return "Task " + operation + " accepted."
    }
    if (["approve", "deny", "answer"].includes(action)) {
      const choices = state.deliveries.filter(
        (row) => ["approval", "question"].includes(row.kind) && (owner || row.requester === update.requester),
      )
      const selected = reply ?? (choices.length === 1 ? choices[0] : undefined)
      if (!selected?.input || !selected.target || !selected.task || (!owner && selected.requester !== update.requester))
        return "Reply to your specific pending request with the decision."
      const work = state.work.find((work) => work.input === selected.input)
      if (!work) return "The original request is no longer available."
      const execution = telegramExecution(this.application(), work)
      await execution.recover({ signal: this.signal }).then(executionSnapshot)
      const decision = (await execution.decisions({ signal: this.signal })).find(
        (row) => row.detail.task.key === selected.task,
      )
      if (!decision) return "This decision is no longer pending."
      if (decision.kind === "approval" && !owner) return "Only the Bot owner can approve or deny tool requests."
      if (decision.kind === "approval" && action === "approve") await decision.task.approve({ signal: this.signal })
      else if (decision.kind === "approval" && action === "deny")
        await decision.task.deny(undefined, { signal: this.signal })
      else if (decision.kind === "ask" && action === "answer" && argument)
        await decision.task.resolve({ content: argument }, { signal: this.signal })
      else return "Use /approve or /deny for an approval, or /answer followed by text for a question."
      await document.change((state) => ({
        ...state!,
        deliveries: state!.deliveries.filter((row) => row.id !== selected.id),
        messages: [
          ...(state!.messages ?? []),
          {
            id: selected.id,
            route: selected.route,
            requester: selected.requester,
            target: selected.target,
            input: selected.input,
            kind: selected.kind,
            status: "sent",
            message: selected.message,
            text: "",
          },
        ],
      }))
      return "Decision submitted."
    }
    if (action === "stop") {
      const source =
        update.reply &&
        state.batches.find(
          (row) =>
            row.sources.some((source) => source.message === update.reply) &&
            (owner || row.requester === update.requester),
        )
      if (source) {
        if (source.submission) return "Admission has started; reconcile the accepted request before stopping it."
        await document.change((state) => ({
          ...state!,
          batches: state!.batches.flatMap((row) =>
            row.id !== source.id
              ? [row]
              : row.sources.length === 1
                ? []
                : [{ ...row, sources: row.sources.filter((source) => source.message !== update.reply) }],
          ),
        }))
        if (source.inference)
          await this.application()
            .client.workspace(source.target.workspace)
            .inferenceRequests.cancel(source.inference, { signal: this.signal })
        return "Removed the queued source message."
      }
      const choices = state.work.filter(
        (row) => (argument || reply || update.reply || !row.terminal) && (owner || row.requester === update.requester),
      )
      const work = argument
        ? choices.find((row) => row.input === argument)
        : reply?.input
          ? choices.find((row) => row.input === reply.input)
          : update.reply
            ? choices.find((row) => row.source.includes(update.reply!))
            : choices.length === 1
              ? choices[0]
              : undefined
      if (!work) return choices.length ? "Reply to a specific request to stop its work." : "No active request to stop."
      const chat = this.application().client.workspace(work.target.workspace).conversation(work.target.conversation)
      const execution = telegramExecution(this.application(), work)
      const snapshot = await execution.recover({ signal: this.signal }).then(executionSnapshot)
      if (snapshot?.execution.run_public_id)
        await this.application()
          .client.workspace(work.target.workspace)
          .run(snapshot.execution.run_public_id)
          .stop(false, { signal: this.signal })
      else await chat.inputs.delete(work.input, { signal: this.signal })
      return "Stop requested; completion is observed separately."
    }
    const conversationResult = await telegramConversationCommand(action, argument, {
      application: this.application(),
      bot: id,
      current: bot.current,
      owner,
      key: keyValue,
      signal: this.signal,
      model: state.model,
      tracking: {
        document,
        update: update.id,
        route: {
          connection: binding.connection_public_id!,
          chat: update.chat,
          topic: update.topic,
          group: update.group,
        },
        requester: update.requester,
        speaker: async () => {
          const speaker = await this.application().client.profile.registerIngressSpeaker(
            {
              channel_key: "telegram:" + id,
              external_id: update.requester,
              display_name: update.user?.first_name ?? update.requester,
            },
            { signal: this.signal },
          )

          return speaker.public_id
        },
      },
    })
    if (conversationResult !== undefined) return conversationResult
    if (action === "memory") return this.memory(id, bot, update, argument)
    if (!owner) return "Only the Bot owner can change shared conversation settings."
    if (action === "observe") {
      if (!["on", "off"].includes(argument)) return "Use /observe on|off."
      await document.change((state) => ({ ...state!, observe: argument === "on" }))
      return "Group observation: " + argument + "."
    }
    if (action === "mode") {
      if (!["assistant", "active"].includes(argument)) return "Use /mode assistant|active."
      await document.change((state) => ({ ...state!, mode: argument as "assistant" | "active" }))
      return "Group participation: " + argument + "."
    }
    if (action === "new" || action === "resume") {
      const args = argument.split(/\s+/)
      if (action === "resume" && args.length !== 2) return "Use /resume WORKSPACE_ID CONVERSATION_ID."
      const receipt = Schema.decodeUnknownSync(Selected)(
        await this.application().bots.command(
          action === "new"
            ? { action: "bot.new", id, key: keyValue }
            : { action: "bot.resume", id, key: keyValue, workspace: args[0], conversation: args[1] },
        ),
      )
      await document.change((state) => ({ ...state!, batches: state!.batches.filter((row) => !!row.submission) }))
      return "Current conversation: " + receipt.selected.public_id + "."
    }
    if (action === "history")
      return JSON.stringify(await this.application().bots.command({ action: "bot.history", id })).slice(0, 4000)
    if (action === "model") {
      const models = await this.application().client.models.list(
        { workload: "text_generation" },
        { signal: this.signal },
      )
      if (!models.some((row) => row.ref === argument))
        return "That model is not available. Use /model to list the available models."
      await document.change((state) => ({ ...state!, model: argument }))
      return "Model set to " + argument + " for new requests."
    }
    if (action === "voice") {
      if (!["off", "voice_only", "all"].includes(argument)) return "Use /voice off|voice_only|all."
      await document.change((state) => ({ ...state!, voice: argument as TelegramState["voice"] }))
      return "Voice replies: " + argument + "."
    }
    if (action === "workspace") {
      const [operation, ...words] = argument.split(/\s+/)
      const value = words.join(" ")
      const choices = []
      let after: string | undefined
      do {
        const page = await this.application().client.workspaces.list({ after }, { signal: this.signal })
        choices.push(...page.items)
        after = page.next_after ?? undefined
      } while (after)
      if (!operation || operation === "list")
        return (
          "Current workspace: " +
          (bot.current?.workspace_public_id ?? "none") +
          "\n" +
          choices.map((row) => row.name + " · " + row.public_id).join("\n") +
          "\nUse /workspace use ID or /workspace create NAME."
        )
      if (!["use", "create"].includes(operation) || !value)
        return "Use /workspace list, /workspace current, /workspace use ID or /workspace create NAME."
      const matches = choices.filter((row) => row.public_id === value || row.name === value)
      if (operation === "use" && matches.length !== 1)
        return matches.length
          ? "Several workspaces have that name. Use a public ID from /workspace list."
          : "That workspace is not available. Use /workspace list."
      const selected =
        operation === "create"
          ? (
              await this.application().client.workspaces.create(
                { name: value },
                { idempotencyKey: keyValue + ":workspace", signal: this.signal },
              )
            ).workspace.public_id
          : matches[0].public_id
      await this.application().bots.command({
        action: "bot.workspace",
        id,
        key: keyValue,
        workspace: selected,
      })
      await document.change((state) => ({ ...state!, batches: state!.batches.filter((row) => !!row.submission) }))
      return "Home Workspace selected and a new current conversation opened."
    }
    if (action === "compact" && bot.current) {
      await this.application()
        .client.workspace(bot.current.workspace_public_id)
        .conversation(bot.current.public_id)
        .compact(undefined, { signal: this.signal })
      return "Compaction requested."
    }
    void now
    return "Unknown command. Use /help."
  }

  private async memory(id: string, bot: typeof Bot.Type, update: TelegramUpdate, argument: string) {
    if (!bot.current) return "Send a message to open a conversation before using /memory."
    const speaker = await this.application().client.profile.registerIngressSpeaker(
      {
        channel_key: "telegram:" + id,
        external_id: update.requester,
        display_name: update.user?.first_name ?? update.requester,
      },
      { signal: this.signal },
    )
    return telegramMemoryCommand(argument, {
      application: this.application(),
      workspace: bot.current.workspace_public_id,
      conversation: bot.current.public_id,
      speaker: speaker.public_id,
      signal: this.signal,
    })
  }
}

function key(...parts: (string | number)[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)
}
function sameRoute(a: TelegramDelivery["route"], b: TelegramDelivery["route"]) {
  return a.connection === b.connection && a.chat === b.chat && a.topic === b.topic
}
function enqueue(rows: readonly TelegramDelivery[], delivery: TelegramDelivery): TelegramDelivery[] {
  return rows.some((row) => row.id === delivery.id) ? [...rows] : [...rows, delivery]
}
function permitted(
  binding: TelegramBinding,
  state: TelegramState,
  requester: string,
  group: boolean,
  chat = binding.target?.chat_id,
) {
  const owner = requester === binding.owner_id
  return (
    (owner || (!state.access.ignored_users.includes(requester) && state.access.allowed_users.includes(requester))) &&
    (!group || (!!chat && state.access.allowed_chats.includes(chat)))
  )
}
function accessChange(
  binding: TelegramBinding,
  access: TelegramState["access"],
  list: keyof TelegramState["access"],
  operation: "add" | "remove",
  id: string,
) {
  if (!(list === "allowed_chats" ? /^-[1-9][0-9]*$/ : /^[1-9][0-9]*$/).test(id))
    throw new Error("Use a " + (list === "allowed_chats" ? "negative group" : "positive user") + " Telegram ID.")
  if (id === binding.owner_id) throw new Error("The Bot owner is always allowed and cannot be removed or ignored.")
  return {
    ...access,
    [list]: operation === "add" ? [...new Set([...access[list], id])] : access[list].filter((value) => value !== id),
  }
}
