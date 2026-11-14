import type { ScheduleRuleInput } from "@cybros/agent"
import type { NexusApplication } from "./application"

export function telegramTime(expression: string, now: number) {
  if (expression === "now") return new Date(now).toISOString()
  const [mode, value] = expression.split(/\s+/)
  if (mode === "in") return new Date(now + duration(value) * 1000).toISOString()
  if (mode === "at" && value && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString()
  throw new Error("Use in DURATION, at an ISO timestamp with its UTC offset, or now.")
}

export function telegramRule(text: string, now: number): { rule: ScheduleRuleInput; prompt: string } {
  const [kind, ...words] = text.split(/\s+/)
  if (kind === "once")
    return {
      rule: { kind: "once", run_at: telegramTime(words.slice(0, 2).join(" "), now) },
      prompt: words.slice(2).join(" "),
    }
  if (kind === "every") {
    const seconds = duration(words[0])
    return {
      rule: { kind: "interval", every_seconds: seconds, starts_at: new Date(now + seconds * 1000).toISOString() },
      prompt: words.slice(1).join(" "),
    }
  }
  if (kind === "daily" && /^\d\d:\d\d$/.test(words[0] ?? "") && words[1]) {
    new Intl.DateTimeFormat("en", { timeZone: words[1] }).format(now)
    return { rule: { kind: "daily", local_time: words[0], time_zone: words[1] }, prompt: words.slice(2).join(" ") }
  }
  throw new Error(
    "Use once in DURATION, once at TIME, every DURATION, or daily HH:MM IANA_ZONE, followed by the job prompt.",
  )
}

export async function telegramJob(
  argument: string,
  context: {
    application: NexusApplication
    bot: string
    workspace: string
    conversation: string
    speaker: string
    owner: boolean
    key: string
    now: number
    signal: AbortSignal
    model?: string
  },
) {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument)
  const action = match?.[1] ?? "list"
  const rest = match?.[2] ?? ""
  const schedules = context.application.client.workspace(context.workspace).conversation(context.conversation).schedules
  const options = { signal: context.signal }
  if (action === "list") {
    const page = await schedules.list(rest ? { after: rest } : {}, options)
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
  const [id, ...words] = rest.split(/\s+/)
  if (action === "show") return { text: JSON.stringify(await schedules.fetch(id, options), null, 2) }
  if (action === "history")
    return {
      text: JSON.stringify(await schedules.executions(id, words[0] ? { after: words[0] } : {}, options), null, 2),
    }
  if (!context.owner) return { text: "Only the Bot owner can change scheduled jobs." }
  if (action === "create") {
    const parsed = telegramRule(rest, context.now)
    if (!parsed.prompt.trim()) throw new Error("A scheduled job needs a prompt.")
    const policy = await context.application.bots.capture({
      action: "bot.submit",
      id: context.bot,
      workspace: context.workspace,
      conversation: context.conversation,
      key: context.key + ":policy",
      text: parsed.prompt,
      speaker: context.speaker,
      ...(context.model ? { model: context.model } : {}),
    })
    const receipt = await schedules.create(
      {
        ...parsed,
        answering_user_public_id: context.bot,
        speaker_public_id: context.speaker,
        model: policy.model,
        fallback_models: [...policy.fallback_models!],
        ...(policy.tool_names ? { tool_names: [...policy.tool_names] } : {}),
        ...(policy.executor_contexts ? { executor_contexts: policy.executor_contexts } : {}),
      },
      { ...options, idempotencyKey: context.key },
    )
    return { text: "Scheduled job " + receipt.schedule.public_id + ".", schedule: receipt.schedule.public_id }
  }
  if (action === "edit") {
    const current = await schedules.fetch(id, options)
    const text = words.slice(1).join(" ")
    const rule = words[0] === "prompt" ? undefined : telegramRule(words.join(" "), context.now)
    if (rule?.prompt || (words[0] === "prompt" && !text))
      throw new Error("Use /job edit ID prompt TEXT, or /job edit ID RULE without a trailing prompt.")
    const change = rule ? { rule: rule.rule } : { prompt: text }
    await schedules.update(id, { ...change, expected_lock_version: current.lock_version }, options)
    return { text: "Scheduled job updated." }
  }
  if (action === "pause" || action === "resume" || action === "cancel" || action === "run") {
    await schedules[action](id, options)
    return { text: "Job " + action + " accepted." }
  }
  return {
    text: "Use /job list|show ID|history ID|create RULE TEXT|edit ID prompt TEXT|pause ID|resume ID|cancel ID|run ID.",
  }
}

function duration(text = "") {
  const match = /^(\d+)(s|m|h|d)$/.exec(text)
  const units = { s: 1, m: 60, h: 3600, d: 86400 }
  const seconds = match ? Number(match[1]) * units[match[2] as keyof typeof units] : 0
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("Use a positive duration such as 20m, 1h or 2d.")
  return seconds
}
