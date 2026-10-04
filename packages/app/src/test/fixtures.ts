import type { SessionInfo, SessionMessageUser } from "@opencode/client/promise"

export function sessionInfo(input: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "session",
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: "/repo" },
    time: { created: 0, updated: 0 },
    ...input,
  }
}

export function userMessage(input: Partial<SessionMessageUser> = {}): SessionMessageUser {
  return { id: "message", type: "user", text: "", time: { created: 0 }, ...input }
}
