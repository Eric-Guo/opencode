import { createHash } from "node:crypto"
import { APIError, type UploadRef, type Variant } from "@cybros/agent"
import type { NexusApplication } from "./application"
import type { StoreDocument } from "./document"
import type { TelegramDelivery, TelegramState, TelegramWork } from "./telegram-state"
import { telegramRender } from "./telegram-render"
import { publishedArtifacts } from "./published-artifacts"

export async function telegramWorkers(
  document: StoreDocument<TelegramState>,
  application: NexusApplication,
  signal: AbortSignal,
  bind?: (work: TelegramWork, answerer: string) => Promise<void>,
) {
  const state = await document.read()
  if (!state) return
  const parents = [...state.work.filter((work) => !work.worker), ...(state.jobs ?? [])]
  const roots = [...new Map(parents.map((row) => [row.target.conversation, row.target])).values()]
  for (const root of roots) {
    const chat = application.client.workspace(root.workspace).conversation(root.conversation)
    const children = await chat.children({}, { signal })
    for (const child of children.items) {
      if (!child.active_turn_public_id) continue

      const turn = await application.client
        .workspace(root.workspace)
        .conversation(child.public_id)
        .turns.fetch(child.active_turn_public_id, undefined, { signal })
        .catch((error: unknown) => {
          if (error instanceof APIError && [403, 404, 410].includes(error.status)) return null
          throw error
        })
      if (
        !turn?.input_public_id ||
        turn.kind !== "direct_reply" ||
        turn.inherited ||
        turn.sender_conversation_public_id !== root.conversation
      )
        continue
      const known = state.work.find((work) => work.input === turn.input_public_id)
      if (known) {
        if (bind && !known.answerer) await bind(known, turn.answering_user_public_id)
        continue
      }
      const owner =
        turn.sender_run_public_id &&
        state.work.find((work) => work.execution?.run_public_id === turn.sender_run_public_id)
      if (!owner) continue
      await document.change((state) => ({
        ...state!,
        work: state!.work.some((work) => work.input === turn.input_public_id)
          ? state!.work
          : [
              ...state!.work,
              {
                id: "worker:" + turn.input_public_id,
                route: owner.route,
                target: { ...owner.target, conversation: child.public_id },
                input: turn.input_public_id!,
                requester: owner.requester,
                speaker: owner.speaker,
                source: [],
                voice: false,
                worker: true,
                terminal: false,
              },
            ],
      }))
      const registered = (await document.read())!.work.find((row) => row.input === turn.input_public_id)!
      if (bind && !registered.answerer) await bind(registered, turn.answering_user_public_id)
    }
    const cursor = state.history?.[root.conversation] ?? { position: 0, pending: [] }
    const page = await chat.turns.list({ after_position: cursor.position, limit: 100 }, { signal })
    const pending = await Promise.all(
      cursor.pending.map((id) =>
        chat.turns.fetch(id, undefined, { signal }).catch((error: unknown) => {
          if (error instanceof APIError && [403, 404, 410].includes(error.status)) return null
          throw error
        }),
      ),
    )
    const turns = [
      ...new Map(
        [...pending.filter((row) => row !== null), ...page.items].map((turn) => [turn.public_id, turn]),
      ).values(),
    ]
    for (const turn of turns.filter((turn) => !turn.inherited && turn.callback_sources.length)) {
      for (const source of turn.callback_sources) {
        const saved = (await document.read())!
        const owner =
          saved.work.find(
            (work) => source.sender_run_public_id && work.execution?.run_public_id === source.sender_run_public_id,
          ) ??
          saved.work.find(
            (work) =>
              work.target.conversation === root.conversation &&
              work.speaker === source.result.requester_speaker_public_id,
          )
        const existing = saved.work.find((work) => work.input === source.result.input_public_id)
        if (!owner && !existing) continue
        if (existing?.canonical) continue
        const work = existing ?? {
          ...owner!,
          id: "worker:" + source.result.input_public_id,
          target: { workspace: root.workspace, conversation: source.result.conversation_public_id },
          input: source.result.input_public_id,
          source: [],
          worker: true,
        }
        const canonical = {
          turn_public_id: source.result.turn_public_id,
          variant_public_id: source.result.variant_public_id,
          run_public_id: source.result.run_public_id,
        }
        await document.change((state) => ({
          ...state!,
          work: existing
            ? state!.work.map((row) => (row.input === work.input ? { ...row, canonical, terminal: false } : row))
            : [
                ...state!.work,
                {
                  id: work.id,
                  route: work.route,
                  target: work.target,
                  requester: work.requester,
                  speaker: work.speaker,
                  source: [],
                  input: work.input,
                  voice: false,
                  worker: true,
                  canonical,
                  terminal: false,
                },
              ],
        }))
        if (bind && !work.answerer) {
          const child = await application.client
            .workspace(work.target.workspace)
            .conversation(work.target.conversation)
            .turns.fetch(canonical.turn_public_id, { include_hidden: true }, { signal })
          await bind(
            (await document.read())!.work.find((row) => row.input === work.input)!,
            child.answering_user_public_id,
          )
        }
      }
      const variant = turn.active_variant
      if (!variant || variant.status !== "completed") continue
      const actors = [...new Set(turn.callback_sources.map((row) => row.result.requester_speaker_public_id))]
      const owner =
        actors.length === 1
          ? parents.find((row) => row.target.conversation === root.conversation && row.speaker === actors[0])
          : undefined
      if (!owner) continue
      const report: TelegramWork = {
        id: "report:" + turn.public_id + ":" + variant.public_id,
        route: owner.route,
        target: owner.target,
        requester: owner.requester,
        speaker: owner.speaker,
        source: [],
        input: turn.input_public_id ?? "turn:" + turn.public_id,
        voice: false,
        report: true,
        terminal: true,
        execution: {
          turn_public_id: turn.public_id,
          variant_public_id: variant.public_id,
          run_public_id: variant.run_public_id,
        },
      }
      const saved = (await document.read())!
      if (saved.work.some((work) => work.id === report.id)) continue
      const files = await publishedArtifacts(
        application.client,
        root.workspace,
        {
          run: variant.run_public_id,
          results: turn.callback_sources
            .filter(
              (source) => !saved.work.some((row) => row.input === source.result.input_public_id && row.result_route),
            )
            .map((source) => source.result),
        },
        signal,
      )
      await document.change((state) => ({
        ...state!,
        work: state!.work.some((work) => work.id === report.id) ? state!.work : [...state!.work, report],
        deliveries: appendResult(state!.deliveries, report, variant, files),
      }))
    }
    await document.change((state) => ({
      ...state!,
      history: {
        ...state!.history,
        [root.conversation]: {
          position: Math.max(cursor.position, ...page.items.map((turn) => turn.position)),
          pending: turns
            .filter((turn) => turn.callback_sources.length && turn.active_variant?.status !== "completed")
            .map((turn) => turn.public_id),
        },
      },
    }))
  }
  for (const work of ((await document.read())?.work ?? []).filter(
    (work) => work.worker && work.canonical && work.result_route && !work.terminal,
  )) {
    const result = await application.client
      .workspace(work.target.workspace)
      .conversation(work.target.conversation)
      .turns.variant(work.canonical!.turn_public_id, work.canonical!.variant_public_id, { signal })
      .catch((error: unknown) => {
        if (error instanceof APIError && [403, 404, 410].includes(error.status)) return null
        throw error
      })
    if (!result || result.variant.status !== "completed") continue
    const files = await publishedArtifacts(
      application.client,
      work.target.workspace,
      {
        results: [
          {
            ...work.canonical!,
            conversation_public_id: work.target.conversation,
            input_public_id: work.input,
            requester_speaker_public_id: work.speaker,
            status: "completed",
          },
        ],
      },
      signal,
    )
    await document.change((state) => ({
      ...state!,
      work: state!.work.map((row) => (row.id === work.id ? { ...row, terminal: true } : row)),
      deliveries: appendResult(state!.deliveries, work, result.variant, files),
    }))
  }
}

function appendResult(
  existing: readonly TelegramDelivery[],
  work: TelegramWork,
  variant: Variant,
  files: readonly UploadRef[],
) {
  const route = work.report ? work.route : (work.result_route ?? work.route)
  const rows: TelegramDelivery[] = [
    ...telegramRender(variant.content ?? "").map(
      (chunk, index): TelegramDelivery => ({
        id: key(work.id, variant.public_id, "text", index),
        route,
        target: work.target,
        requester: work.requester,
        input: work.input,
        ...(work.canonical || work.execution
          ? {
              execution: {
                turn: (work.canonical ?? work.execution)!.turn_public_id,
                variant: variant.public_id,
                canonical: !!work.worker,
              },
            }
          : {}),
        ...chunk,
        kind: "answer",
        status: "pending",
      }),
    ),
    ...files.map(
      (upload): TelegramDelivery => ({
        id: key(work.id, variant.public_id, upload.public_id),
        route,
        target: work.target,
        requester: work.requester,
        input: work.input,
        ...(work.canonical || work.execution
          ? {
              execution: {
                turn: (work.canonical ?? work.execution)!.turn_public_id,
                variant: variant.public_id,
                canonical: !!work.worker,
              },
            }
          : {}),
        text: "",
        kind: "file",
        status: "pending",
        upload,
      }),
    ),
  ]
  return rows.reduce(
    (all, row) => (all.some((existing) => existing.id === row.id) ? all : [...all, row]),
    [...existing],
  )
}
function key(...parts: (string | number)[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)
}
