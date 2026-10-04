import { Predicate } from "effect"
import type { SessionInfo, SessionMessageAssistant, SessionMessageInfo, ShellInfo } from "@opencode/client/promise"
import { createMemo } from "solid-js"

type Task =
  | { id: string; type: "subagent"; label: string; agent?: string }
  | { id: string; type: "shell"; label: string }

export function createSessionBackground(input: {
  sessionID: () => string | undefined
  messages: (id: string) => SessionMessageInfo[]
  sessions: () => SessionInfo[]
  status: (id: string) => "idle" | "running"
  shells: () => ShellInfo[]
}) {
  const history = createMemo(() => {
    const completed = new Set<string>()
    const subagents: { id: string; type: "subagent"; label: string; agent: string | undefined }[] = []
    const shells: { partID: string; task: { id: string; type: "shell"; label: string } }[] = []
    const id = input.sessionID()

    const assistant = (id ? input.messages(id) : []).reduce<SessionMessageAssistant | undefined>((latest, message) => {
      if (message.type === "synthetic") {
        if (message.metadata?.source === "subagent" && Predicate.isString(message.metadata.childID))
          completed.add(message.metadata.childID)

        if (message.metadata?.source === "shell") {
          if (Predicate.isString(message.metadata.shellID)) completed.add(message.metadata.shellID)

          if (Predicate.isString(message.metadata.jobID)) completed.add(message.metadata.jobID)
        }

        return latest
      }

      if (message.type !== "assistant") return latest
      message.content.forEach((part) => {
        if (part.type !== "tool" || (part.name !== "subagent" && part.name !== "shell")) return

        if (part.state.status !== "completed" || part.state.metadata?.status !== "running") return

        if (part.name === "subagent") {
          const sessionID = part.state.metadata.sessionID

          if (!Predicate.isString(sessionID)) return
          const description = part.state.input.description
          const agent = part.state.input.agent
          subagents.push({
            id: sessionID,
            type: "subagent",
            label: Predicate.isString(description) ? description : sessionID,
            agent: Predicate.isString(agent) ? agent : undefined,
          })

          return
        }

        const shellID = part.state.metadata.shellID
        const command = part.state.input.command
        shells.push({
          partID: part.id,
          task: {
            id: Predicate.isString(shellID) ? shellID : part.id,
            type: "shell",
            label: Predicate.isString(command) ? command : part.id,
          },
        })
      })

      return message.time.completed === undefined ? message : latest
    }, undefined)

    return {
      // Completion notices can identify the shell or its original tool call.
      subagents: subagents.filter((task) => !completed.has(task.id)),
      shells: shells.flatMap((item) =>
        !completed.has(item.partID) && !completed.has(item.task.id) ? [item.task] : [],
      ),
      blocking:
        assistant?.content.flatMap((part) => {
          if (part.type !== "tool" || part.state.status !== "running") return []

          if (part.name !== "shell" && part.name !== "subagent") return []
          const value = part.name === "shell" ? part.state.metadata.shellID : part.state.metadata.sessionID
          const label = part.name === "shell" ? part.state.input.command : part.state.input.description

          return [
            {
              type: part.name === "shell" ? ("shell" as const) : ("subagent" as const),
              partID: part.id,
              id: Predicate.isString(value) ? value : undefined,
              label: Predicate.isString(label) ? label : undefined,
            },
          ]
        }) ?? [],
    }
  })

  const blocking = createMemo(() => history().blocking)

  const tasks = createMemo(() => {
    const id = input.sessionID()

    if (!id) return []
    const current = history()

    const active = input.sessions().flatMap((info) => {
      if (info?.parentID !== id) return []

      if (input.status(info.id) === "idle") return []

      if (
        current.blocking.some(
          (item) => item.type === "subagent" && (item.id === info.id || (!!item.label && info.title === item.label)),
        )
      )
        return []

      return [{ id: info.id, type: "subagent" as const, label: info.title ?? info.id }]
    })

    const running = input.shells().flatMap((shell) => {
      if (shell.status !== "running" || shell.metadata.sessionID !== id) return []

      if (
        current.blocking.some(
          (item) => item.type === "shell" && (item.id === shell.id || (!!item.label && shell.command === item.label)),
        )
      )
        return []

      return [{ id: shell.id, type: "shell" as const, label: shell.command }]
    })

    return [
      ...new Map<string, Task>(
        [...current.subagents, ...active, ...current.shells, ...running].map((task) => [task.id, task]),
      ).values(),
    ]
  })

  return { blocking, tasks }
}
