import type { JsonObject } from "@cybros/agent"

export function conversationFixture(fields: JsonObject = {}): JsonObject {
  return {
    public_id: "conversation",
    workspace_public_id: "workspace",
    answering_user_public_id: "main",
    archived_at: null,
    side: false,
    lock_version: 0,
    context_revision: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {},
    input_queue: { limit: 100, held: 0 },
    usage_summary: {
      request_count: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      uncached_input_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
      cost_amount: "0",
      cost_complete: true,
    },
    access: { default: "full", entries: [] },
    effective_memory_context: {},
    agent_configuration_present: false,
    cost_limit_reached: false,
    ...fields,
  }
}

export function inputFixture(fields: JsonObject = {}): JsonObject {
  return {
    public_id: "input",
    queue_position: 1,
    state: "pending",
    kind: "direct_reply",
    role: "user",
    delivery_mode: "queue",
    context_options: {},
    lock_version: 0,
    created_at: new Date().toISOString(),
    origin: "direct",
    answering_user_public_id: "main",
    speaker: { user_public_id: "human", handle: "@human", kind: "human" },
    ...fields,
  }
}
