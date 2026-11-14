import { APIError } from "@cybros/agent"
import type { NexusApplication } from "./application"
import type { StoreDocument } from "./document"
import type { TelegramState, TelegramWork } from "./telegram-state"

/** Candidate changes keep their own watch because they do not advance history positions. */
export async function telegramCandidates(
  document: StoreDocument<TelegramState>,
  application: NexusApplication,
  signal: AbortSignal,
) {
  for (const watch of (await document.read())?.candidates ?? []) {
    const chat = application.client.workspace(watch.target.workspace).conversation(watch.target.conversation)
    const deck = await chat.turns.variants(watch.turn, { signal }).catch((error: unknown) => {
      if (error instanceof APIError && [403, 404, 410].includes(error.status)) return null
      throw error
    })
    const variant = deck?.items.find((row) =>
      watch.variant ? row.public_id === watch.variant : !watch.known.includes(row.public_id),
    )
    if (deck && !variant) continue
    await document.change((state) => {
      const work: TelegramWork | undefined = variant
        ? {
            id: "candidate:" + variant.public_id,
            route: watch.route,
            target: watch.target,
            requester: watch.requester,
            speaker: watch.speaker,
            source: [],
            input: variant.public_id,
            voice: false,
            candidate: true,
            execution: {
              turn_public_id: watch.turn,
              variant_public_id: variant.public_id,
              run_public_id: variant.run_public_id,
            },
          }
        : undefined
      return {
        ...state!,
        candidates: state!.candidates!.filter((row) => row.id !== watch.id),
        work: work && !state!.work.some((row) => row.id === work.id) ? [...state!.work, work] : state!.work,
      }
    })
  }
}

export function telegramExecution(application: NexusApplication, work: TelegramWork) {
  const chat = application.client.workspace(work.target.workspace).conversation(work.target.conversation)
  return (work.candidate || work.report) && work.execution
    ? chat.execution(work.execution)
    : work.canonical
      ? chat.execution(work.canonical)
      : chat.inputExecution(work.input)
}
