import { Schema } from "effect"
import { APIError } from "@cybros/agent"
import type { NexusApplication } from "./application"
import type { StoreDocument } from "./document"
import type { TelegramState, TelegramWork } from "./telegram-state"

const Page = Schema.Struct({
  next_after: Schema.optional(Schema.NullOr(Schema.String)),
  items: Schema.Array(
    Schema.Struct({
      public_id: Schema.String,
      workspace_public_id: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

/** Chat commands operate on the selected Bot's existing Nexus authorities. */
export async function telegramConversationCommand(
  action: string,
  argument: string,
  context: {
    application: NexusApplication
    bot: string
    current: { public_id: string; workspace_public_id: string } | null
    owner: boolean
    key: string
    signal: AbortSignal
    model?: string
    tracking?: {
      document: StoreDocument<TelegramState>
      route: TelegramWork["route"]
      requester: string
      speaker: string
    }
  },
) {
  const application = context.application
  const options = { signal: context.signal }
  if (action === "sessions") {
    const page = Number(argument || "1")
    if (!Number.isInteger(page) || page < 1) return "Use /sessions PAGE with a positive page number."
    const rows = await botHistory(application, context.bot)
    return (
      rows
        .slice((page - 1) * 10, page * 10)
        .map((row) => (row.title ?? "Untitled") + "\n" + row.public_id + " · " + row.workspace_public_id)
        .join("\n\n") || "No saved conversations on this page."
    )
  }
  if (action === "resume" && !argument.includes(" ")) {
    if (!context.owner) return "Only the Bot owner can change the shared conversation."
    const row = (await botHistory(application, context.bot)).find((row) => row.public_id === argument)
    if (!row) return "Choose a saved conversation ID from /sessions."
    await application.bots.command({
      action: "bot.resume",
      id: context.bot,
      key: context.key,
      workspace: row.workspace_public_id,
      conversation: row.public_id,
    })
    return "Current conversation: " + row.public_id + "."
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
  if (!context.current) return "Send a message to open a conversation first."
  const mutating =
    !["history", "variants", "context", "search"].includes(action) ||
    (action === "history" && !!argument && !argument.startsWith("before "))
  if (mutating && !context.owner) return "Only the Bot owner can change the shared conversation."
  const locator =
    argument && ["archive", "restore"].includes(action)
      ? (await botHistory(application, context.bot)).find((row) => row.public_id === argument)
      : context.current
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
    await scope.compact(undefined, options)
    return "Compaction requested."
  }
  if (action === "context")
    return JSON.stringify(
      await scope.estimateInput(
        { prompt: "", render: true, ...(context.model ? { model: { model: context.model } } : {}) },
        options,
      ),
      null,
      2,
    )
  if (action === "search") {
    if (!argument) return "Use /search TEXT or /search next."
    const history = await botHistory(application, context.bot)
    const key = context.tracking ? context.tracking.route.chat + ":" + context.tracking.route.topic : "current"
    const saved =
      argument === "next"
        ? (await context.tracking?.document.read())?.searches?.[key]
        : { query: argument, workspaces: [...new Set(history.map((row) => row.workspace_public_id))], after: null }
    if (!saved?.workspaces.length) return "No search continuation is saved. Use /search TEXT."
    const result = await application.client
      .workspace(saved.workspaces[0])
      .conversations.search(
        { query: saved.query, answering_user_public_id: context.bot, ...(saved.after ? { after: saved.after } : {}) },
        options,
      )
    const next = {
      ...saved,
      after: result.next_after,
      workspaces: result.next_after ? saved.workspaces : saved.workspaces.slice(1),
    }
    await context.tracking?.document.change((state) => ({
      ...state!,
      searches: { ...state!.searches, [key]: next.workspaces.length ? next : null },
    }))
    const matches = result.matches.filter((match) =>
      history.some(
        (row) => row.public_id === match.conversation_public_id && row.workspace_public_id === saved.workspaces[0],
      ),
    )
    return (
      (matches
        .map(
          (row) =>
            (row.title ?? "Untitled") +
            "\n" +
            row.conversation_public_id +
            (row.position === null ? "" : " · turn " + row.position) +
            "\n" +
            (row.excerpt ?? ""),
        )
        .join("\n\n") || "No matches from this Bot in this search window.") +
      (next.workspaces.length ? "\nUse /search next for the next search window." : "")
    )
  }
  if (action === "history") {
    const [verb, id] = argument.split(/\s+/)
    const changes: Record<string, { visibility?: string; concealed?: boolean }> = {
      hide: { visibility: "hidden" },
      show: { visibility: "visible" },
      include: { visibility: "visible" },
      exclude: { visibility: "excluded_from_context" },
      delete: { concealed: true },
      restore: { concealed: false },
    }
    if (verb && changes[verb]) {
      if (!id) return "Specify the stable turn ID from /history."
      await scope.turns.setViewState(id, changes[verb], options)
      return "History view updated."
    }
    if (argument && (verb !== "before" || !/^\d+$/.test(id ?? ""))) return "Use /history or /history before POSITION."
    return JSON.stringify(
      await scope.history({ before_position: id ? Number(id) : undefined, limit: 20 }, options),
      null,
      2,
    )
  }
  const match = /^(\d+)(?:\s+([\s\S]*))?$/.exec(argument)
  const page = await scope.turns.list(
    { ...(match ? { before_position: Number(match[1]) + 1 } : {}), limit: 1, include_hidden: true },
    options,
  )
  const turn = page.items[0]
  if (!turn || (match && turn.position !== Number(match[1]))) return "Choose a turn position from /history."
  const track = async (variant?: string) => {
    if (!context.tracking) return
    const tracking = context.tracking
    const deck = await scope.turns.variants(turn.public_id, options)
    await tracking.document.change((state) => ({
      ...state!,
      candidates: [
        ...(state!.candidates ?? []).filter((row) => row.id !== context.key),
        {
          id: context.key,
          route: tracking.route,
          target: { workspace: locator.workspace_public_id, conversation: locator.public_id },
          requester: tracking.requester,
          speaker: tracking.speaker,
          turn: turn.public_id,
          previous: turn.active_variant?.public_id ?? null,
          known: deck.items.map((row) => row.public_id),
          ...(variant ? { variant } : {}),
        },
      ],
    }))
  }
  if (action === "fork") {
    const receipt = await application.bots.command({
      action: "bot.fork",
      id: context.bot,
      key: context.key,
      workspace: locator.workspace_public_id,
      conversation: locator.public_id,
      turn: turn.public_id,
    })
    return "Fork selected: " + JSON.stringify(receipt)
  }
  if (action === "regenerate") {
    await track()
    await scope.turns.regenerate(turn.public_id, context.model ? { model: { model: context.model } } : {}, {
      ...options,
      idempotencyKey: context.key,
    })
    return "Regeneration requested. The selected result will be delivered here."
  }
  if (action === "variants") return JSON.stringify(await scope.turns.variants(turn.public_id, options), null, 2)
  if (action === "variant") {
    const [id, verb] = (match?.[2] ?? "").split(/\s+/)
    if (!id || (verb && !["hide", "restore"].includes(verb))) return "Use /variant POSITION ID [hide|restore]."
    if (verb) await scope.turns.setVariantViewState(turn.public_id, id, { concealed: verb === "hide" }, options)
    else {
      await track(id)
      await scope.turns.activate(turn.public_id, id, options)
    }
    return "Variant updated."
  }
  if (action === "edit") {
    if (!match?.[2]) return "Use /edit POSITION TEXT."
    await track()
    await scope.turns.edit(turn.public_id, { text: match[2] }, options)
    return "Edited tail candidate added."
  }
  if (action === "undo") {
    await scope.turns.delete(turn.public_id, options)
    return "Newest turn deleted."
  }
}

export async function telegramMemoryCommand(
  argument: string,
  context: {
    application: NexusApplication
    workspace: string
    conversation: string
    speaker: string
    signal: AbortSignal
  },
) {
  const memory = context.application.client
    .workspace(context.workspace)
    .conversation(context.conversation)
    .memory(context.speaker)
  const options = { signal: context.signal }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument)
  const action = match?.[1] ?? "ls"
  const rest = match?.[2] ?? ""
  if (action === "ls" || action === "list")
    return (
      (await memory.list(options))
        .filter((row) => !rest || row.path.startsWith(rest))
        .map((row) => row.path + " (" + row.bytesize + " bytes)")
        .join("\n") || "No memory documents."
    )
  if (action === "read" && rest) {
    const row = await memory.read(rest, options)
    return row.path + "\n" + (row.content ?? "")
  }
  if (action === "grep" && rest) return JSON.stringify(await memory.grep({ pattern: rest }, options), null, 2)
  const fields =
    action === "edit"
      ? Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({ path: Schema.NonEmptyString, old_text: Schema.NonEmptyString, new_text: Schema.String }),
          ),
        )(rest)
      : (() => {
          const split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)
          return { path: split?.[1] ?? "", content: split?.[2] ?? "" }
        })()
  if (
    !["write", "edit", "delete"].includes(action) ||
    !fields.path ||
    (action === "write" && !("content" in fields && fields.content))
  )
    return "Use /memory ls [PATH], read PATH, write PATH TEXT, edit JSON, grep TEXT, or delete PATH."
  const current = await memory.read(fields.path, options).catch((error: unknown) => {
    if (action === "write" && error instanceof APIError && error.status === 404) return null
    throw error
  })
  const binding = (await memory.bindings(options)).bindings.find((row) => row.name === fields.path.split("/")[0])
  if (!binding?.collection_public_id || binding.access !== "read_write")
    return "That memory scope is unavailable or read-only for this requester."
  const collection = { expected_collection_public_id: binding.collection_public_id }
  if (action === "write" && "content" in fields)
    await memory.write(
      {
        ...fields,
        ...collection,
        expected_public_id: current?.public_id ?? null,
        expected_lock_version: current?.lock_version ?? null,
      },
      options,
    )
  if (!current && action !== "write") return "Memory document not found."
  if (action === "edit" && "old_text" in fields)
    await memory.edit(
      {
        ...fields,
        ...collection,
        expected_public_id: current!.public_id,
        expected_lock_version: current!.lock_version,
      },
      options,
    )
  if (action === "delete")
    await memory.delete(
      fields.path,
      { ...collection, expected_public_id: current!.public_id, expected_lock_version: current!.lock_version },
      options,
    )
  return "Memory " + action + " completed: " + fields.path
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
