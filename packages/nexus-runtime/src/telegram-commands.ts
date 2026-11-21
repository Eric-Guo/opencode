import { Schema } from "effect"
import { APIError } from "@cybros/agent"
import type { NexusApplication } from "./application"
import type { StoreDocument } from "./document"
import type { TelegramState, TelegramWork } from "./telegram-state"
import { TURN_POSITION_CEILING } from "./history"
import { candidateReply, settleCandidate } from "./telegram-candidates"
import { telegramPreview } from "./telegram-render"

const Page = Schema.Struct({
  next_after: Schema.optional(Schema.NullOr(Schema.String)),
  items: Schema.Array(
    Schema.Struct({
      public_id: Schema.String,
      workspace_public_id: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      archived_at: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})
const Selected = Schema.Struct({
  selected: Schema.Struct({ public_id: Schema.String, workspace_public_id: Schema.String }),
})
type Conversation = typeof Selected.Type.selected
type Route = TelegramWork["route"]

function sessionRoute(route: Route) {
  return JSON.stringify([route.connection, route.chat, route.topic])
}

function sessionHistory(state: TelegramState, route: Route) {
  return state.sessions?.[sessionRoute(route)] ?? { cursors: {}, listed: {}, tracked: {} }
}

export function telegramSessionSwitch(
  state: TelegramState,
  route: Route,
  conversations: readonly (Conversation | null)[],
) {
  const key = sessionRoute(route)
  const batches = state.batches.filter((row) => !row.submission && sessionRoute(row.route) === key)
  const voices = state.deliveries.filter(
    (row) => row.kind === "voice" && ["pending", "preparing"].includes(row.status) && sessionRoute(row.route) === key,
  )
  const cancellations = [...batches, ...voices].flatMap((row) =>
    row.inference && row.target ? [{ workspace: row.target.workspace, inference: row.inference }] : [],
  )

  return telegramTrackConversations(
    {
      ...state,
      batches: state.batches.filter((row) => !batches.includes(row)),
      deliveries: state.deliveries.filter((row) => !voices.includes(row)),
      ...(cancellations.length
        ? { media_cancellations: [...(state.media_cancellations ?? []), ...cancellations] }
        : {}),
    },
    route,
    conversations,
  )
}

export function telegramTrackConversations(
  state: TelegramState,
  route: Route,
  conversations: readonly (Conversation | null)[],
) {
  const history = sessionHistory(state, route)
  const key = sessionRoute(route)

  return {
    ...state,
    sessions: {
      ...state.sessions,
      [key]: {
        ...history,
        tracked: {
          ...history.tracked,
          ...Object.fromEntries(
            conversations.flatMap((row) => (row ? [[row.public_id, row.workspace_public_id]] : [])),
          ),
        },
      },
    },
  }
}

/** Chat commands operate on the selected Bot's existing Nexus authorities. */
export async function telegramConversationCommand(
  action: string,
  argument: string,
  context: {
    application: NexusApplication
    bot: string
    current: Conversation | null
    owner: boolean
    key: string
    signal: AbortSignal
    model?: string
    tracking?: {
      document: StoreDocument<TelegramState>
      update: number
      message?: number
      route: TelegramWork["route"]
      requester: string
      speaker: () => Promise<string>
    }
  },
) {
  const application = context.application
  const options = { signal: context.signal }
  const tracking = context.tracking
  if (action === "sessions") {
    if (argument && !/^[1-9][0-9]{0,7}$/.test(argument)) return "Use /sessions [PAGE] with a positive page number."

    const page = Number(argument || "1")
    const state = await tracking?.document.read()
    const after = page > 1 && state && tracking ? sessionHistory(state, tracking.route).cursors[page] : undefined

    if (page > 1 && !after) return "That page has not been listed yet. Use /sessions and follow its next page."

    const result = Schema.decodeUnknownSync(Page)(
      await application.bots.command(
        { action: "bot.history", id: context.bot, limit: 10, ...(after ? { after } : {}) },
        options,
      ),
    )
    await tracking?.document.change((state) => {
      const history = sessionHistory(state!, tracking.route)
      const cursors = Object.fromEntries(Object.entries(history.cursors).filter(([key]) => Number(key) <= page))

      if (result.next_after) cursors[page + 1] = result.next_after

      return {
        ...state!,
        sessions: {
          ...state!.sessions,
          [sessionRoute(tracking.route)]: {
            ...history,
            cursors,
            listed: Object.fromEntries(result.items.map((row) => [row.public_id, row.workspace_public_id])),
          },
        },
      }
    })
    if (!result.items.length) return "No conversations are saved on this page. Send a message or use /new to start one."

    const rows = result.items.map((row) => {
      const title = Array.from(row.title?.replace(/\s+/g, " ").trim() || "Untitled conversation")
        .slice(0, 120)
        .join("")
      return (
        title +
        (row.public_id === context.current?.public_id ? " [current]" : "") +
        (row.archived_at ? " [archived]" : "") +
        "\n" +
        row.public_id
      )
    })

    return (
      "Bot conversations (page " +
      page +
      "):\n" +
      rows.join("\n\n") +
      "\n\nThe Bot owner can use /resume ID to select a conversation." +
      (result.next_after ? "\nNext page: /sessions " + (page + 1) : "")
    )
  }
  if (action === "resume") {
    if (!context.owner) return "Only the Bot owner can change the shared conversation."
    if (!/^\S+$/.test(argument)) return "Use /resume ID."

    const state = await tracking?.document.read()
    const original = state?.control?.update === tracking?.update ? state?.control?.resume : undefined

    if (original?.reply) return original.reply

    const history = state && tracking ? sessionHistory(state, tracking.route) : undefined
    const tracked =
      state && tracking
        ? [...state.work, ...state.batches].find(
            (row) => row.target.conversation === argument && sessionRoute(row.route) === sessionRoute(tracking.route),
          )?.target.workspace
        : undefined
    const workspace =
      history?.listed[argument] ??
      history?.tracked[argument] ??
      tracked ??
      (argument === context.current?.public_id ? context.current.workspace_public_id : undefined)
    const target = original?.target ?? (workspace ? { workspace, conversation: argument } : undefined)

    if (!target) return "Choose a saved conversation ID from /sessions."
    if (tracking && !original)
      await tracking.document.change((state) => ({
        ...state!,
        control: { ...state?.control, update: tracking.update, resume: { target } },
      }))

    const receipt = Schema.decodeUnknownSync(Selected)(
      await application.bots.command(
        {
          action: "bot.resume",
          id: context.bot,
          key: context.key,
          ...target,
        },
        options,
      ),
    )
    const reply =
      "Resumed conversation " +
      receipt.selected.public_id +
      ". Earlier work still reports to its original conversation."

    await tracking?.document.change((state) => ({
      ...telegramSessionSwitch(state!, tracking.route, [context.current, receipt.selected]),
      control: { ...state?.control, update: tracking.update, resume: { target, reply } },
    }))
    return reply
  }
  if (
    ![
      "history",
      "rename",
      "archive",
      "restore",
      "fork",
      "regenerate",
      "variants",
      "variant",
      "edit",
      "undo",
      "context",
      "compact",
      "codemode",
      "search",
    ].includes(action)
  )
    return
  if (action === "codemode") return "Code Mode stays off in Bot conversations."
  if (action === "search") {
    if (!argument.trim()) return "Use /search TEXT or /search next."
    if (!tracking) return "No conversations are saved in this chat/topic."

    const key = sessionRoute(tracking.route)
    const state = await tracking.document.read()
    const tracked = {
      ...(state ? sessionHistory(state, tracking.route).tracked : {}),
      ...Object.fromEntries(
        [...(state?.work ?? []), ...(state?.batches ?? [])]
          .filter((row) => sessionRoute(row.route) === key)
          .map((row) => [row.target.conversation, row.target.workspace]),
      ),
    }
    const saved =
      argument === "next"
        ? state?.searches?.[key]
        : { query: argument, workspaces: [...new Set(Object.values(tracked))], after: null }

    if (!saved) return "No search continuation is saved. Use /search TEXT."
    const workspace = saved.workspaces[0]
    if (!workspace) return "No conversations are saved in this chat/topic."

    const result = await application.client.workspace(workspace).conversations.search(
      {
        query: saved.query,
        archived: "include",
        answering_user_public_id: context.bot,
        limit: 50,
        ...(saved.after ? { after: saved.after } : {}),
      },
      options,
    )
    const next = {
      ...saved,
      after: result.next_after,
      workspaces: result.next_after ? saved.workspaces : saved.workspaces.slice(1),
    }
    await tracking.document.change((state) => ({
      ...state!,
      searches: { ...state!.searches, [key]: next.workspaces.length ? next : null },
    }))
    const matches = result.matches
      .filter((match) => tracked[match.conversation_public_id] === workspace)
      .map(
        (row) =>
          (row.title ?? "Untitled conversation") +
          "\n" +
          row.conversation_public_id +
          (row.position === null ? "" : " · turn " + row.position) +
          "\n" +
          (row.excerpt ?? ""),
      )
    return telegramWindow(
      matches.length
        ? "Matches in this chat/topic:\n" + matches.join("\n\n")
        : "No matches from this chat/topic in this search window.",
      next.workspaces.length ? "\nUse /search next for the next search window." : "",
    )
  }
  const mutating =
    !["history", "variants", "context"].includes(action) ||
    (action === "history" && !!argument && !/^before(?:\s|$)/.test(argument))
  if (mutating && !context.owner) return "Only the Bot owner can change the shared conversation."
  const forkControl = action === "fork" ? (await tracking?.document.read())?.control : undefined
  const frozen = forkControl?.update === tracking?.update ? forkControl?.fork : undefined
  const current = frozen
    ? { public_id: frozen.target.conversation, workspace_public_id: frozen.target.workspace }
    : context.current
  if (!current) return "Send a message to open a conversation first."

  const locator =
    argument && ["archive", "restore"].includes(action)
      ? (await botHistory(application, context.bot)).find((row) => row.public_id === argument)
      : current
  if (!locator) return "Choose a saved conversation ID from /sessions."
  const scope = application.client.workspace(locator.workspace_public_id).conversation(locator.public_id)
  if (action === "rename") {
    if (!argument.trim()) return "Use /rename TITLE."
    const current = await scope.fetch(options)
    await scope.update({ title: argument, lock_version: current.lock_version }, options)
    return "Conversation renamed."
  }
  if (action === "archive") {
    await scope.archive(options)
    return "Conversation archived. Use /restore or /new."
  }
  if (action === "restore") {
    await scope.unarchive(options)
    return "Conversation restored."
  }
  if (action === "compact") {
    if (argument) return "Use /compact."
    await scope.compact(undefined, options)
    return "Compaction requested."
  }
  if (action === "context") {
    if (argument) return "Use /context."
    return JSON.stringify(
      await scope.estimateInput(
        {
          prompt: "",
          render: true,
          answering_user_public_id: context.bot,
          speaker_public_id: await tracking?.speaker(),
          ...(context.model ? { model: { model: context.model } } : {}),
        },
        options,
      ),
      null,
      2,
    )
  }
  if (action === "history") {
    const [verb, id, extra] = argument.split(/\s+/)
    const changes: Record<string, { visibility?: string; concealed?: boolean }> = {
      hide: { visibility: "hidden" },
      show: { visibility: "visible" },
      include: { visibility: "visible" },
      exclude: { visibility: "excluded_from_context" },
      delete: { concealed: true },
      restore: { concealed: false },
    }
    const fields = Object.hasOwn(changes, verb) ? changes[verb] : undefined
    if (fields) {
      if (!id || extra) return "Specify one stable turn ID from /history."
      await scope.turns.setViewState(id, fields, options)
      return "History view updated."
    }
    if (argument && (verb !== "before" || extra || !/^\d+$/.test(id ?? "") || Number(id) > TURN_POSITION_CEILING))
      return "Use /history or /history before POSITION."
    const page = await scope.history({ before_position: id ? Number(id) : undefined, limit: 10 }, options)
    const turns = page.turns.map((turn) =>
      ["Turn " + turn.position + " · " + turn.public_id, turn.prompt, turn.content, turn.steers]
        .filter(Boolean)
        .join("\n"),
    )
    return telegramWindow(
      turns.join("\n\n") || "No visible history in this window.",
      page.has_older && page.before_position !== null
        ? "\n\nOlder history: /history before " + page.before_position
        : "",
    )
  }
  const match = /^(\d+)(?:\s+([\s\S]*))?$/.exec(argument)
  const position = match ? Number(match[1]) : undefined
  const value = match?.[2]
  const usage = "Use /" + action + " as shown in /help."
  if (argument && (position === undefined || position >= TURN_POSITION_CEILING)) return usage
  if (action === "undo" && argument) return usage
  if (["variants", "variant", "edit"].includes(action) && position === undefined) return usage
  if (["fork", "regenerate", "variants"].includes(action) && value) return usage
  if (["variant", "edit"].includes(action) && !value?.trim()) return usage
  const [variant, view, extra] = action === "variant" ? value!.split(/\s+/) : []
  if (action === "variant" && (extra || (view && !["hide", "restore"].includes(view))))
    return "Use /variant POSITION ID [hide|restore]."

  const turn = frozen
    ? undefined
    : (
        await scope.turns.list(
          { before_position: position === undefined ? TURN_POSITION_CEILING : position + 1, limit: 1 },
          options,
        )
      ).items[0]
  const turnID = frozen?.turn ?? turn?.public_id
  if (!turnID || (!frozen && position !== undefined && turn?.position !== position))
    return "Choose a turn position from /history."

  if (action === "fork") {
    const active = turn?.active_variant?.public_id
    const fork = frozen ?? {
      target: { workspace: locator.workspace_public_id, conversation: locator.public_id },
      turn: turnID,
      ...(active ? { variant: active } : {}),
    }

    if (tracking && !frozen)
      await tracking.document.change((state) => ({
        ...state!,
        control: { ...state?.control, update: tracking.update, fork },
      }))

    const receipt = await application.bots.command({
      action: "bot.fork",
      id: context.bot,
      key: context.key,
      workspace: fork.target.workspace,
      conversation: fork.target.conversation,
      turn: fork.turn,
      ...(fork.variant ? { variant: fork.variant } : {}),
    })
    const selected = Schema.decodeUnknownSync(Selected)(receipt).selected
    await tracking?.document.change((state) => telegramSessionSwitch(state!, tracking.route, [current, selected]))
    return "Fork selected: " + JSON.stringify(receipt)
  }
  if (action === "variants") {
    const deck = await scope.turns.variants(turnID, options)
    const rows = deck.items.map(
      (row) =>
        row.public_id +
        " · " +
        row.status +
        (row.active ? " [active]" : "") +
        "\n" +
        telegramPreview(row.content ?? row.content_preview ?? "", 500),
    )
    return telegramWindow("Candidates for turn " + position + ":\n" + rows.join("\n\n"), "")
  }
  if (action === "undo") {
    await scope.turns.delete(turnID, options)
    return "Newest turn deleted."
  }
  if (action === "variant" && view) {
    await scope.turns.setVariantViewState(turnID, variant, { concealed: view === "hide" }, options)
    return "Variant updated."
  }

  const operation = action === "regenerate" || action === "edit" ? action : "activate"
  const execute = () => {
    if (operation === "regenerate")
      return scope.turns
        .regenerate(turnID, context.model ? { model: { model: context.model } } : {}, {
          ...options,
          idempotencyKey: context.key,
        })
        .then((result) => result.variant)
    if (operation === "edit") return scope.turns.edit(turnID, { text: value! }, options)
    return scope.turns.activate(turnID, variant, options)
  }
  if (tracking) {
    const deck = await scope.turns.variants(turnID, options)
    const speaker = await tracking.speaker()
    const watch = {
      id: context.key,
      route: tracking.route,
      target: { workspace: locator.workspace_public_id, conversation: locator.public_id },
      requester: tracking.requester,
      speaker,
      turn: turnID,
      previous: deck.items.find((row) => row.active)?.public_id ?? turn?.active_variant?.public_id ?? null,
      known: deck.items.map((row) => row.public_id),
      operation,
      update: tracking.update,
      message: tracking.message,
      ...(variant ? { variant } : {}),
    } satisfies NonNullable<TelegramState["candidates"]>[number]
    await tracking.document.change((state) => ({
      ...state!,
      candidates: [...(state!.candidates ?? []).filter((row) => row.id !== watch.id), watch],
    }))
    const result = await execute().catch(async (error: unknown) => {
      if (error instanceof APIError && error.status < 500 && ![408, 429].includes(error.status))
        await tracking.document.change((state) => ({
          ...state!,
          candidates: (state!.candidates ?? []).filter((row) => row.id !== watch.id),
        }))
      throw error
    })
    await tracking.document.change((state) => settleCandidate(state!, watch, result))
    return candidateReply(operation, result)
  }
  return candidateReply(operation, await execute())
}

function telegramWindow(body: string, footer: string) {
  const limit = 12000 - footer.length
  return (body.length > limit ? body.slice(0, limit - 1).replace(/\p{Surrogate}$/u, "") + "…" : body) + footer
}

async function botHistory(application: NexusApplication, bot: string) {
  const items: Array<(typeof Page.Type.items)[number]> = []
  let after: string | undefined
  do {
    const page = Schema.decodeUnknownSync(Page)(
      await application.bots.command({ action: "bot.history", id: bot, ...(after ? { after } : {}) }),
    )
    items.push(...page.items)
    after = page.next_after ?? undefined
  } while (after)
  return items
}
