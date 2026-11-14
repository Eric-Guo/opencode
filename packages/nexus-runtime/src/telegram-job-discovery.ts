import { APIError } from "@cybros/agent"
import type { NexusApplication } from "./application"
import type { StoreDocument } from "./document"
import type { TelegramState } from "./telegram-state"

/** Model-authored schedules keep the original task's actor and destination, including after a current switch. */
export async function telegramJobDiscovery(
  document: StoreDocument<TelegramState>,
  application: NexusApplication,
  bot: string,
  signal: AbortSignal,
) {
  const state = await document.read()
  if (!state) return
  const targets = [
    ...new Map(
      state.work
        .filter((work) => !work.worker)
        .map((work) => [work.target.workspace + ":" + work.target.conversation, work.target]),
    ).values(),
  ]
  for (const target of targets) {
    let after: string | undefined
    do {
      const page = await application.client
        .workspace(target.workspace)
        .conversation(target.conversation)
        .schedules.list({ after }, { signal })
        .catch((error: unknown) => {
          if (error instanceof APIError && [403, 404, 410].includes(error.status)) return null
          throw error
        })
      if (!page) break
      for (const schedule of page.items.filter((row) => row.answering_user_public_id === bot)) {
        const owner = state.work.find(
          (work) =>
            work.target.workspace === target.workspace &&
            work.target.conversation === target.conversation &&
            (schedule.source_run_public_id
              ? work.execution?.run_public_id === schedule.source_run_public_id
              : !!schedule.speaker_public_id && work.speaker === schedule.speaker_public_id),
        )
        if (!owner) continue
        await document.change((state) => ({
          ...state!,
          jobs: state!.jobs?.some((row) => row.id === schedule.public_id)
            ? state!.jobs
            : [
                ...(state!.jobs ?? []),
                {
                  id: schedule.public_id,
                  route: owner.route,
                  target,
                  requester: owner.requester,
                  speaker: owner.speaker,
                },
              ],
        }))
      }
      after = page.next_after ?? undefined
    } while (after)
  }
}
