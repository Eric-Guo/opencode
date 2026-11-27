import type { Client, Schedule } from "@cybros/agent"
import type { AttentionPolicy, ChannelSource, ChannelsOverview, EventRule, Observation } from "./channels"

export const checkInPrefix =
  "[Check-in Routine: stay silent and report concisely only if something material changed or needs human action]\n"

/** The slice of Channels that Routines reads; constructor-injected so the modules stay decoupled. */
export interface RoutinesChannels {
  sources(): Promise<ChannelSource[]>
  eventRules(): Promise<EventRule[]>
  attentionPolicy(): Promise<AttentionPolicy>
  overview(): Promise<ChannelsOverview>
}

export type TimeRoutine = {
  kind: "time"
  public_id: string
  conversation_public_id?: string
  name: string
  what: string
  starts: Schedule["rule"]
  does: string
  wake: string
  status: string
  enabled: boolean
  lock_version: number
  next_run_at?: string
}

export type EventRoutine = {
  kind: "event"
  public_id: string
  name: string
  what: string
  starts: { type: "event"; source_key: string; pattern?: string }
  does: string
  accept_mode: string
  status: string
  enabled: boolean
  updated_at: string
}

export type RoutinesList = {
  routines: (TimeRoutine | EventRoutine)[]
  time_routines: TimeRoutine[]
  event_routines: EventRoutine[]
  attention_policy: AttentionPolicy
  observations: Observation[]
}

export function doesForWake(wake: string | null | undefined): "check_in" | "act" {
  return wake === "passive" ? "check_in" : "act"
}

export function wakeForDoes(does: string | null | undefined): "passive" | "auto" {
  return does === "check_in" ? "passive" : "auto"
}

export function preparePrompt(prompt: string, does: string | null | undefined): string {
  const clean = prompt.trim()

  if (does === "check_in" && !clean.startsWith(checkInPrefix.trim())) return checkInPrefix + clean
  return clean
}

/**
 * Unified Routines view over the two orthogonal triggers: time routines backed by Nexus Schedules
 * and event routines backed by Channels event rules. Every row reads as What, Starts, Does, Until.
 */
export class Routines {
  constructor(private readonly channels: RoutinesChannels) {}

  async list(input: { client: Client; workspace_public_id: string }): Promise<RoutinesList> {
    const schedules = (await input.client.workspace(input.workspace_public_id).schedules.list({ limit: 100 })).items
    const timeRows = schedules.map(projectSchedule)
    const sourcesByKey = new Map((await this.channels.sources()).map((source) => [source.source_key, source]))
    const eventRows = (await this.channels.eventRules()).map((rule) => projectEventRule(rule, sourcesByKey))

    return {
      routines: [...timeRows, ...eventRows],
      time_routines: timeRows,
      event_routines: eventRows,
      attention_policy: await this.channels.attentionPolicy(),
      observations: (await this.channels.overview()).observations,
    }
  }
}

function projectSchedule(schedule: Schedule): TimeRoutine {
  const prompt = schedule.prompt.startsWith(checkInPrefix)
    ? schedule.prompt.slice(checkInPrefix.length)
    : schedule.prompt

  return {
    kind: "time",
    public_id: schedule.public_id,
    ...(schedule.conversation_public_id ? { conversation_public_id: schedule.conversation_public_id } : {}),
    name: schedule.name ?? Array.from(prompt.split("\n")[0].trim()).slice(0, 60).join(""),
    what: prompt,
    starts: schedule.rule,
    does: doesForWake(schedule.wake),
    wake: schedule.wake,
    status: schedule.status,
    enabled: schedule.status === "active",
    lock_version: schedule.lock_version,
    ...(schedule.next_run_at ? { next_run_at: schedule.next_run_at } : {}),
  }
}

function projectEventRule(rule: EventRule, sourcesByKey: Map<string, ChannelSource>): EventRoutine {
  const acceptMode = rule.source_key === "*" ? "observe" : (sourcesByKey.get(rule.source_key)?.accept_mode ?? "observe")

  return {
    kind: "event",
    public_id: rule.public_id,
    name: rule.name,
    what: rule.instructions,
    starts: { type: "event", source_key: rule.source_key, ...(rule.pattern ? { pattern: rule.pattern } : {}) },
    does: rule.does,
    accept_mode: acceptMode,
    status: rule.enabled ? (acceptMode === "auto" ? "active" : "observe") : "paused",
    enabled: rule.enabled,
    updated_at: rule.updated_at,
  }
}
