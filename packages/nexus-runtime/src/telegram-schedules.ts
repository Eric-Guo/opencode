import type { ScheduleExecutionPage } from "@cybros/agent"
import type { parseJob } from "./jobs"
import type { NexusApplication } from "./application"
import type { StoreDocument } from "./document"
import type { TelegramState } from "./telegram-state"

const settled = new Set(["completed", "failed", "canceled"])

type Job = NonNullable<TelegramState["jobs"]>[number]

/** Save the occurrences and their poll position together. An operator's history read can start at any cursor. */
export async function recordJobExecutions(
  document: StoreDocument<TelegramState>,
  job: Job,
  page: ScheduleExecutionPage,
  poll?: { after?: string },
) {
  if (!page.items.length) return

  await document.change((state) => {
    const work = [...state!.work]
    const indexes = new Map(work.map((row, index) => [row.input, index]))

    for (const row of page.items) {
      if (!row.input_public_id) continue

      const index = indexes.get(row.input_public_id) ?? work.length
      const previous = work[index]
      indexes.set(row.input_public_id, index)
      work[index] = {
        ...previous,
        id: previous?.id ?? "scheduled:" + row.input_public_id,
        route: job.route,
        target: { workspace: job.target.workspace, conversation: row.child_conversation_public_id },
        requester: job.requester,
        speaker: job.speaker,
        source: previous?.source ?? [],
        input: row.input_public_id,
        voice: previous?.voice ?? false,
        worker: true,
        schedule: job.id,
        ...(row.turn_public_id &&
          (row.variant_public_id || row.run_public_id) && {
            execution: {
              turn_public_id: row.turn_public_id,
              variant_public_id: row.variant_public_id,
              run_public_id: row.run_public_id,
            },
          }),
        ...(row.status === "canceled" && !row.turn_public_id && { terminal: true }),
      }
    }

    const cursor =
      poll && page.items.every((row) => row.run_public_id || settled.has(row.status)) ? page.last_cursor : null

    return {
      ...state!,
      work,
      ...(cursor && {
        jobs: state!.jobs?.map((item) =>
          item.id === job.id && item.execution_after === poll?.after ? { ...item, execution_after: cursor } : item,
        ),
      }),
    }
  })
}

export async function telegramJob(
  command: ReturnType<typeof parseJob>,
  context: {
    application: NexusApplication
    bot: string
    workspace: string
    conversation: string
    speaker: string
    owner: boolean
    key: string
    signal: AbortSignal
    model?: string
  },
) {
  const action = command.action
  const schedules = context.application.client.workspace(context.workspace).conversation(context.conversation).schedules
  const options = { signal: context.signal }
  if (action === "list") {
    const page = await schedules.list({ after: command.after }, options)
    const rows = page.items.filter((row) => context.owner || row.speaker_public_id === context.speaker)
    return {
      text:
        rows
          .map(
            (row) =>
              row.public_id +
              " · " +
              row.status +
              " · " +
              (row.name ?? row.prompt.split("\n")[0]) +
              " · next: " +
              (row.next_run_at ?? "none"),
          )
          .join("\n") + (page.next_after ? "\nMore: /job list " + page.next_after : "") || "No scheduled jobs.",
    }
  }
  if (action === "show") return { text: JSON.stringify(await schedules.fetch(command.id, options), null, 2) }
  if (action === "history") {
    const page = await schedules.executions(command.id, { after: command.after, limit: 25 }, options)
    const lines = page.items.map((row) =>
      [
        row.input_public_id ? "Task: " + row.input_public_id : "Scheduled execution",
        row.status,
        row.scheduled_for,
      ].join(" · "),
    )
    if (page.next_after) lines.push("More: /job history " + command.id + " " + page.next_after)

    return { text: lines.join("\n") || "No executions yet.", executions: page }
  }
  if (!context.owner) return { text: "Only the Bot owner can change scheduled jobs." }
  if (action === "create") {
    const policy = await context.application.bots.capture({
      action: "bot.submit",
      id: context.bot,
      workspace: context.workspace,
      conversation: context.conversation,
      key: context.key + ":policy",
      text: command.create.prompt,
      speaker: context.speaker,
      ...(context.model ? { model: context.model } : {}),
    })
    const receipt = await schedules.create(
      {
        ...command.create,
        answering_user_public_id: context.bot,
        speaker_public_id: context.speaker,
        model: policy.model,
        model_selection: policy.model_selection,
        fallback_models: [...policy.fallback_models!],
        ...(policy.tool_names ? { tool_names: [...policy.tool_names] } : {}),
        ...(policy.executor_contexts ? { executor_contexts: policy.executor_contexts } : {}),
      },
      { ...options, idempotencyKey: context.key },
    )
    return { text: "Scheduled job " + receipt.schedule.public_id + ".", schedule: receipt.schedule.public_id }
  }
  if (action === "edit") {
    const current = await schedules.fetch(command.id, options)
    await schedules.update(command.id, { ...command.change, expected_lock_version: current.lock_version }, options)
    return { text: "Scheduled job updated." }
  }
  await schedules[action](command.id, options)
  return { text: "Job " + action + " accepted." }
}
