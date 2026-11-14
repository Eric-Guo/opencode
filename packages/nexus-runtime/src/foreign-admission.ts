import type { Client, CreateInput, JsonObject, RequestOptions } from "@cybros/agent"

/** Explicit member addressing uses the recipient's declaration; the kernel owns access and availability. */
export async function addressedAgent(
  client: Client,
  workspace: string,
  own: string,
  address: string,
  options: RequestOptions = {},
) {
  if (address === own) return own
  const scope = client.workspace(workspace)
  const principals = await scope.principals(options)
  const identifier = address.trim().replace(/^@/, "")
  const principal = principals.find((row) => row.public_id === address || row.handle.replace(/^@/, "") === identifier)
  if (!principal || principal.kind !== "agent")
    throw new Error("The addressee must name a member agent of this workspace.")
  if (principal.public_id === own) return own
  if ((await scope.fetch(options)).dedicated)
    throw new Error("A dedicated workspace can only address its paired agent.")
  if (
    (await client.profile.agents.list(options)).some(
      (row) =>
        row.public_id === principal.public_id &&
        row.derived_from_public_id === own &&
        row.scope === "instance" &&
        row.name.startsWith("bot-"),
    )
  )
    throw new Error("Open this Bot through its current conversation or create a new Bot conversation.")
  return principal.public_id
}

export function foreignInput(
  input: {
    text: string
    model?: string
    instructions?: string
    approval?: "bypass" | "ask" | "rules"
    attachments?: readonly string[]
    delivery?: CreateInput["delivery_mode"]
    deliver_at?: string
    deliver_in?: string
    reasoning_effort?: string
    reasoning_enabled?: boolean
    executor_contexts?: Record<string, JsonObject>
  },
  recipient: string,
): CreateInput & { admission_notes: JsonObject } {
  return {
    kind: "direct_reply",
    text: input.text,
    answering_user_public_id: recipient,
    ...(input.model ? { model: { model: input.model } } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.approval ? { approval_mode: input.approval } : {}),
    ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
    ...(input.delivery ? { delivery_mode: input.delivery } : {}),
    ...(input.deliver_at ? { deliver_at: input.deliver_at } : {}),
    ...(input.deliver_in ? { deliver_in: input.deliver_in } : {}),
    ...(input.executor_contexts ? { executor_contexts: input.executor_contexts } : {}),
    ...(input.reasoning_enabled !== undefined || input.reasoning_effort !== undefined
      ? {
          configuration: {
            ...(input.reasoning_enabled !== undefined ? { reasoning_enabled: input.reasoning_enabled } : {}),
            ...(input.reasoning_effort !== undefined ? { reasoning_effort: input.reasoning_effort } : {}),
          },
        }
      : {}),
    admission_notes: { "nexus.addressed": { recipient } },
  }
}
