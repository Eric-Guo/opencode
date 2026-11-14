import type { AgentContext } from "@agentclientprotocol/sdk"
import type { Client, ConversationHistoryTurn, ThreadRow } from "@cybros/agent"
import { EditorTranscript } from "./editor-follow"

export async function replayEditorHistory(
  workspace: ReturnType<Client["workspace"]>,
  id: string,
  peer: AgentContext,
  signal: AbortSignal,
) {
  const chat = workspace.conversation(id)
  const turns = new Map<number, ConversationHistoryTurn>()
  const page = { before: undefined as number | undefined }
  const projection = new EditorTranscript(id, peer, (run, task) => workspace.run(run).task(task).fetch({ signal }))

  do {
    const history = await chat.history({ before_position: page.before, limit: 100 }, { signal })

    for (const turn of history.turns) turns.set(turn.position, turn)
    if (!history.has_older || history.before_position === null || history.before_position === page.before) break

    page.before = history.before_position
  } while (!signal.aborted)

  for (const turn of [...turns.values()].sort((a, b) => a.position - b.position)) {
    const detail = await chat.turns.fetch(turn.public_id, undefined, { signal })
    const variant = detail.active_variant
    const reference = detail.reference
      ? "[Parent reference" +
        (detail.sender_conversation_public_id ? " from " + detail.sender_conversation_public_id : "") +
        "]\n"
      : ""
    const text = async (field: "prompt" | "content", fallback: string | null) => {
      if (!turn.truncated || !variant) return fallback

      const content: string[] = []
      const cursor = { after: undefined as string | undefined }

      do {
        const page = await chat.turns.field(
          turn.public_id,
          variant.public_id,
          field,
          { after: cursor.after },
          { signal },
        )

        content.push(page.text)
        if (!page.next_after || page.next_after === cursor.after) break

        cursor.after = page.next_after
      } while (!signal.aborted)

      return content.join("")
    }
    const prompt = await text("prompt", turn.prompt)

    if (prompt)
      await peer.notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: reference ? "agent_message_chunk" : "user_message_chunk",
          messageId: turn.public_id + ":user",
          content: { type: "text", text: reference + prompt },
        },
      })
    if (variant?.run_public_id && !reference) {
      const rounds: ThreadRow[][] = []
      const cursor = { before: undefined as string | undefined }

      do {
        const page = await workspace
          .run(variant.run_public_id)
          .transcript({ before: cursor.before, limit: 100 }, { signal })

        rounds.unshift(page.rounds)
        if (!page.has_older || typeof page.next_before !== "string" || page.next_before === cursor.before) break

        cursor.before = page.next_before
      } while (!signal.aborted)

      for (const round of rounds.flat().filter((round) => round.mainline))
        for (const call of round.calls.items) await projection.call(variant.run_public_id, call)
    }

    const content = await text("content", turn.content)

    if (content)
      await peer.notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: turn.public_id + ":0",
          content: { type: "text", text: reference + content },
        },
      })
  }
}
