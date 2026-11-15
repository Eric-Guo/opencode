import type { AgentContext } from "@agentclientprotocol/sdk"
import type { Client, ConversationHistoryTurn, ThreadRow, Turn } from "@cybros/agent"
import { EditorTranscript } from "./editor-follow"

export async function readEditorHistory(
  workspace: ReturnType<Client["workspace"]>,
  id: string,
  signal: AbortSignal,
  peer?: AgentContext,
) {
  const chat = workspace.conversation(id)
  const turns = new Map<number, ConversationHistoryTurn>()
  const page = { before: undefined as number | undefined }
  const projection = peer
    ? new EditorTranscript(id, peer, (run, task) => workspace.run(run).task(task).fetch({ signal }))
    : undefined
  const latest: { turn?: Turn } = {}

  do {
    const history = await chat.history({ before_position: page.before, limit: 100 }, { signal })

    for (const turn of history.turns) turns.set(turn.position, turn)
    if (!history.has_older || history.before_position === null || history.before_position === page.before) break

    page.before = history.before_position
  } while (!signal.aborted)

  for (const turn of [...turns.values()].sort((a, b) => a.position - b.position)) {
    signal.throwIfAborted()
    if (turn.kind === "compaction_summary") continue

    const detail = await chat.turns.fetch(turn.public_id, undefined, { signal })

    if (detail.role === "assistant" && !detail.reference && !detail.inherited) latest.turn = detail
    if (!peer) continue

    const variant = detail.active_variant
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
    if (detail.reference) {
      const content = await text("content", turn.content)

      if (content)
        await peer.notify("session/update", {
          sessionId: id,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: turn.public_id + ":reference",
            content: { type: "text", text: "Parent conversation reference snapshot (context only):\n\n" + content },
          },
        })
      continue
    }
    if (!["user", "assistant"].includes(detail.role)) continue

    const prompt = detail.role === "assistant" ? await text("prompt", turn.prompt) : null

    if (prompt)
      await peer.notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: turn.public_id + ":0",
          content: { type: "text", text: prompt },
        },
      })
    if (detail.role === "assistant" && variant?.run_public_id) {
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
        for (const call of round.calls.items) await projection!.call(variant.run_public_id, call)
    }

    const content = await text("content", turn.content)

    if (content)
      await peer.notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: detail.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          messageId: turn.public_id + ":0",
          content: { type: "text", text: content },
        },
      })
  }

  return latest.turn
}
