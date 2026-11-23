import { Schema } from "effect"
import type { ScheduleRuleInput } from "@cybros/agent"
import type { NexusCommand } from "@opencode/protocol/nexus-command"

export function scheduleTime(expression: string, now: number) {
  const match = /^(now|in|at)(?:\s+([\s\S]+))?$/.exec(expression)
  const mode = match?.[1]
  const value = match?.[2]
  if (mode === "now" && value === undefined) return new Date(now).toISOString()
  if (mode === "in") return new Date(now + duration(value) * 1000).toISOString()
  if (
    mode === "at" &&
    value &&
    value.length <= 40 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:?\d\d)$/i.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return new Date(value).toISOString()
  throw new Error("Use in DURATION, at an ISO timestamp with its UTC offset, or now.")
}

export function scheduleRule(text: string, now: number): { rule: ScheduleRuleInput; prompt: string } {
  const every = /^every\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim())
  if (every) {
    const seconds = duration(every[1])
    if (seconds <= 0) throw new Error("The interval must be positive.")
    return {
      rule: { kind: "interval", every_seconds: seconds, starts_at: new Date(now + seconds * 1000).toISOString() },
      prompt: every[2] ?? "",
    }
  }
  const match = /^(once|daily)\s+(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim())
  if (match?.[1] === "once" && ["in", "at"].includes(match[2]))
    return {
      rule: { kind: "once", run_at: scheduleTime(match[2] + " " + match[3], now) },
      prompt: match[4] ?? "",
    }
  if (match?.[1] === "daily" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(match[2])) {
    new Intl.DateTimeFormat("en", { timeZone: match[3] }).format(now)
    return { rule: { kind: "daily", local_time: match[2], time_zone: match[3] }, prompt: match[4] ?? "" }
  }
  throw new Error(
    "Use once in DURATION, once at TIME, every DURATION, or daily HH:MM IANA_ZONE, followed by the job prompt.",
  )
}

export function parseJob(argument: string, now: number) {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument.trim())
  const action = match?.[1] ?? "list"
  const rest = match?.[2] ?? ""
  if (action === "list") return { action, after: rest || undefined } as const
  if (action === "create") {
    const create = scheduleRule(rest, now)
    if (!create.prompt.trim()) throw new Error("A scheduled job needs a prompt.")

    return { action, create } as const
  }
  const parts = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest)
  const id = parts?.[1] ?? ""
  const tail = parts?.[2] ?? ""
  if (!id) throw new Error("A scheduled job ID is required.")
  if (action === "history") return { action, id, after: tail || undefined } as const
  if (action === "edit") {
    const prompt = /^prompt(?:\s+([\s\S]+))?$/.exec(tail)
    if (prompt?.[1]?.trim()) return { action, id, change: { prompt: prompt[1] } } as const
    const rule = !prompt && scheduleRule(tail, now)
    if (rule && !rule.prompt) return { action, id, change: { rule: rule.rule } } as const
    throw new Error("Use edit ID prompt TEXT or edit ID RULE without a trailing prompt.")
  }
  if (
    !tail &&
    (action === "show" || action === "pause" || action === "resume" || action === "cancel" || action === "run")
  )
    return { action, id } as const
  throw new Error("Use list, show, history, create, edit, pause, resume, cancel, or run.")
}

function duration(text = "") {
  const match = /^(\d{1,9})(s|m|h|d)$/.exec(text)
  const units = { s: 1, m: 60, h: 3600, d: 86400 }
  if (!match) throw new Error("Use a duration such as 20m, 1h or 2d.")
  return Number(match[1]) * units[match[2] as keyof typeof units]
}

const Summary = Schema.Struct({
  public_id: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  name: Schema.NullOr(Schema.String),
  next_run_at: Schema.NullOr(Schema.String),
})
function summary(row: typeof Summary.Type) {
  return [
    row.public_id,
    "schedule: " + row.status,
    row.name ?? row.prompt.split("\n")[0].trim(),
    "next: " + (row.next_run_at ?? "none"),
  ].join(" · ")
}

export async function runJobs(
  conversation: string,
  words: readonly string[],
  options: { workspace?: string; model?: string; json: boolean },
  manage: (command: typeof NexusCommand.Type) => Promise<unknown>,
) {
  const job = parseJob(words.join(" "), Date.now())
  const scope = { workspace: options.workspace, conversation }
  const command = async (): Promise<typeof NexusCommand.Type> => {
    if (job.action === "list") return { action: "schedule.list", ...scope, after: job.after }
    if (job.action === "history") return { action: "schedule.executions", ...scope, id: job.id, after: job.after }
    if (job.action === "create")
      return { action: "schedule.create", ...scope, ...job.create, key: crypto.randomUUID(), model: options.model }
    if (job.action === "edit") {
      const current = Schema.decodeUnknownSync(Schema.Struct({ lock_version: Schema.Int }))(
        await manage({ action: "schedule.read", ...scope, id: job.id }),
      )
      return { action: "schedule.update", ...scope, id: job.id, version: current.lock_version, ...job.change }
    }
    return { action: job.action === "show" ? "schedule.read" : `schedule.${job.action}`, ...scope, id: job.id }
  }
  const result = await manage(await command())
  if (options.json) return JSON.stringify(result, null, 2)

  const next_after = Schema.NullOr(Schema.String)
  if (job.action === "list") {
    const page = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Summary), next_after }))(result)
    const lines = page.items.length ? page.items.map(summary) : ["No scheduled jobs."]
    if (page.next_after) lines.push("More jobs: list " + page.next_after)

    return lines.join("\n")
  }
  if (job.action === "history") {
    const execution = Schema.Struct({
      child_conversation_public_id: Schema.String,
      status: Schema.String,
      scheduled_for: Schema.String,
    })
    const page = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(execution), next_after }))(result)
    const lines = page.items.length
      ? page.items.map((row) => [row.child_conversation_public_id, row.status, row.scheduled_for].join(" · "))
      : ["No executions yet."]
    if (page.next_after) lines.push(`More executions: history ${job.id} ${page.next_after}`)

    return lines.join("\n")
  }
  const row = Schema.decodeUnknownSync(
    Schema.Struct({
      ...Summary.fields,
      rule: Schema.Json,
      last_error_code: Schema.NullOr(Schema.String),
      last_enqueued_at: Schema.NullOr(Schema.String),
      last_execution: Schema.NullOr(
        Schema.Struct({ status: Schema.String, child_conversation_public_id: Schema.String }),
      ),
    }),
  )(result)
  return [
    summary(row),
    row.prompt,
    "Rule: " + JSON.stringify(row.rule),
    row.last_error_code && "Last error: " + row.last_error_code,
    row.last_enqueued_at && "Last enqueued: " + row.last_enqueued_at,
    row.last_execution &&
      `Latest execution: ${row.last_execution.status} · ${row.last_execution.child_conversation_public_id}`,
  ]
    .filter(Boolean)
    .join("\n")
}
