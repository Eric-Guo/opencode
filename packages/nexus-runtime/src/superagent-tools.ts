import { Schema } from "effect"
import type { ExtensionModule } from "./extension-manager"

const Dispatch = Schema.Struct({
  action: Schema.String,
  channel_key: Schema.optional(Schema.String),
  source_key: Schema.optional(Schema.String),
  thread_key: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  proactive: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.String),
  trigger_public_id: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

const Propose = Schema.Struct({
  name: Schema.String,
  scope: Schema.String,
  description: Schema.String,
  content: Schema.String,
})

/** Agent-served coordination tools: external thread delivery and human-reviewed skill proposals. */
export function superagentTools(): ExtensionModule {
  return {
    descriptor: {
      id: "nexus.superagent",
      name: "Superagent coordination",
      description: "Coordinate external threads, channel delivery and skill proposals.",
      default_enabled: true,
      configuration_version: 1,
      configuration_schema: { type: "object", properties: {}, additionalProperties: false },
      defaults: {},
    },
    register(api) {
      api.registerTool({
        role: "agent",
        environmentRequired: false,
        definition: {
          name: "channel_dispatch",
          description:
            "Coordinate external threads and channel delivery for this conversation:\n" +
            "- `reply`: enqueue a semantic message (`acknowledgement`, `answer`, `attention`, or `result`) onto the durable Outbox for `(channel_key, thread_key)`. Keep intermediate progress silent.\n" +
            "- `subscribe`: attach `(source_key, thread_key)` to this conversation in `active` (owns human follow-ups) or `context_only` (silent context) mode.\n" +
            "- `unsubscribe`: drop an unrelated thread subscription from this conversation.\n" +
            "- `handback`: return an out-of-scope human follow-up (`trigger_public_id` + one-sentence `reason`) to the Personal Desk router.",
          effect_profile: {
            kind: "write",
            destructive: false,
            effect_scope: "open",
            idempotency: "intrinsic",
            reconciliation: "none",
          },
          input_schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["reply", "subscribe", "unsubscribe", "handback"] },
              channel_key: {
                type: "string",
                description: "Target channel key for `reply`, e.g. telegram:<connection_id> or webhook:<name>.",
              },
              source_key: { type: "string", description: "Event source key for `subscribe` or `unsubscribe`." },
              thread_key: { type: "string", description: "Thread identifier on the source or channel." },
              purpose: {
                type: "string",
                enum: ["acknowledgement", "answer", "attention", "result"],
                description: "Semantic purpose for `reply`.",
              },
              body: { type: "string", description: "Concise message text for `reply`." },
              proactive: {
                type: "boolean",
                description:
                  "Set true when `reply` is unsolicited background/routine output so quiet-hours and daily limits apply.",
              },
              mode: {
                type: "string",
                enum: ["active", "context_only"],
                description: "Subscription mode (`active` default or `context_only`).",
              },
              trigger_public_id: { type: "string", description: "Trigger UUID to return for `handback`." },
              reason: { type: "string", description: "One-sentence explanation for `handback`." },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
        async execute(value, context) {
          const input = Schema.decodeUnknownSync(Dispatch)(value)
          const command = (operation: unknown) =>
            api.application().operations.command(operation, { signal: context.signal }).then(
              (result) => ({ content: JSON.stringify(result) }),
              (error: unknown) => ({
                content: error instanceof Error ? error.message : "channel_dispatch " + input.action + " refused",
                is_error: true as const,
              }),
            )

          if (input.action === "reply")
            return command({
              action: "channels.outbox.enqueue",
              workspace: context.workspace,
              conversation: context.conversation ?? undefined,
              channel_key: input.channel_key ?? "",
              thread_key: input.thread_key ?? "",
              purpose: input.purpose ?? "result",
              body: input.body ?? "",
              proactive: input.proactive === true,
            })
          if (input.action === "subscribe" || input.action === "unsubscribe") {
            if (!context.conversation) return { content: "public_id is required", is_error: true }

            return command({
              action: input.action === "subscribe" ? "subscriptions.create" : "subscriptions.rm",
              workspace: context.workspace,
              conversation: context.conversation,
              source_key: input.source_key ?? "",
              thread_key: input.thread_key ?? "",
              ...(input.action === "subscribe" ? { mode: input.mode ?? "active" } : {}),
            })
          }
          if (input.action === "handback")
            return command({
              action: "triggers.handback",
              workspace: context.workspace,
              conversation: context.conversation ?? undefined,
              trigger: input.trigger_public_id ?? "",
              reason: input.reason ?? "",
            })
          return { content: "unknown channel_dispatch action: " + input.action, is_error: true }
        },
      })
      api.registerTool({
        role: "agent",
        environmentRequired: false,
        definition: {
          name: "propose_skill",
          description:
            "Propose a reusable Personal (`agent`) or shared (`workspace`) skill draft from a proven workflow or explicit user request. Saving a draft never activates instructions immediately; the owner reviews and approves it in Skills before Nexus publishes `skills/<name>`.",
          effect_profile: {
            kind: "write",
            destructive: false,
            effect_scope: "closed",
            idempotency: "intrinsic",
            reconciliation: "none",
          },
          input_schema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Lowercase hyphenated skill identifier, e.g. weekly-digest or pr-triage.",
              },
              scope: {
                type: "string",
                enum: ["agent", "workspace"],
                description: "Target scope: agent (personal across workspaces) or workspace (shared here).",
              },
              description: {
                type: "string",
                description: "Concise summary shown in the skill catalog when deciding whether to load this skill.",
              },
              content: { type: "string", description: "Complete Markdown instructions for carrying out the skill." },
            },
            required: ["name", "scope", "description", "content"],
            additionalProperties: false,
          },
        },
        async execute(value, context) {
          const input = Schema.decodeUnknownSync(Propose)(value)

          return api.application().operations
            .command(
              {
                action: "skills.drafts.propose",
                workspace: context.workspace,
                conversation: context.conversation ?? undefined,
                name: input.name,
                scope: input.scope,
                description: input.description,
                content: input.content,
              },
              { signal: context.signal },
            )
            .then(
              (created) => ({
                content: JSON.stringify(
                  Schema.decodeUnknownSync(Schema.Struct({ skill_draft: Schema.MutableJson }))(created).skill_draft,
                ),
              }),
              (error: unknown) => ({
                content: error instanceof Error ? error.message : "the daemon refused to save the skill draft",
                is_error: true as const,
              }),
            )
        },
      })
    },
  }
}
