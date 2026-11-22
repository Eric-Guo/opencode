import type { WebSocketHandler } from "bun"

// Nexus publishes every run of a conversation on one channel, including after a fallback.
export const conversationFeeds: WebSocketHandler<undefined> = {
  open(socket) {
    socket.send(JSON.stringify({ type: "welcome" }))
  },
  message(socket, message) {
    const { command, identifier } = JSON.parse(message.toString())
    if (command !== "subscribe") return
    const host = JSON.parse(identifier)
    if (
      host.channel !== "AgentAPI::V1::ConversationEventsChannel" ||
      host.workspace_id !== "workspace" ||
      host.conversation_id !== "conversation"
    ) {
      socket.send(JSON.stringify({ identifier, type: "reject_subscription" }))
      return
    }
    socket.send(JSON.stringify({ identifier, type: "confirm_subscription" }))
    if (!host.items) return
    if (host.items === "transcript") {
      for (const [turn, variant, text] of [
        ["own", "first", "Own"],
        ["own", "sibling", "Foreign"],
        ["other", "first", "Foreign"],
      ])
        socket.send(
          JSON.stringify({
            identifier,
            message: { event: { type: "text_delta", turn_public_id: turn, variant_public_id: variant, text } },
          }),
        )
    }
    for (const run of ["other", "run"]) {
      const frame =
        host.items === "transcript"
          ? { event: { type: "text_delta", run_public_id: run, text: run === "run" ? "Own" : "Foreign" } }
          : { frame: { type: "step_started", at: "now", run_public_id: run, task_key: "live-step", tool_name: "read" } }
      socket.send(JSON.stringify({ identifier, message: frame }))
    }
  },
}
