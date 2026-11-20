import { isAbsolute } from "node:path"
import { Schema } from "effect"
import type { ExtensionManager, ExtensionModule } from "./extension-manager"
import type { Packages } from "./packages"

export function packageTools(owner: Packages, manager: () => ExtensionManager): ExtensionModule {
  return {
    descriptor: {
      id: "nexus.packages",
      name: "Personal extensions",
      description: "Install, check and select immutable local extension versions.",
      default_enabled: true,
      configuration_version: 1,
      configuration_schema: { type: "object", properties: {}, additionalProperties: false },
      defaults: {},
    },
    register(api) {
      api.registerTool({
        role: "agent",
        definition: {
          name: "list_extensions",
          description:
            "List this runner's extensions, including built-ins, with their activation status and registered tools. Also list installed personal package versions and selections for manage_extension. Use tool_search to check which tools are available in this conversation.",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
          effect_profile: {
            kind: "read_only",
            destructive: false,
            effect_scope: "closed",
            idempotency: "intrinsic",
            reconciliation: "none",
          },
        },
        async execute(_, context) {
          context.signal.throwIfAborted()

          const { packages } = await owner.list()
          const extensions = manager()
            .list()
            .map((row) => ({
              id: row.id,
              name: row.name,
              enabled: row.enabled,
              active: row.active,
              ready: row.ready,
              restart_required: row.restart_required,
              tools: row.tools,
            }))

          return { content: JSON.stringify({ extensions, packages }) }
        },
      })
      api.registerTool({
        role: "agent",
        definition: {
          name: "manage_extension",
          description:
            "Manage a personal extension through its installation owner. Develop a writable directory containing nexus-extension.json and extension.ts, then install its absolute path. Check executes its test files with Bun. Activate selects a full installed digest and optional configuration; failed candidates retain the active version. Disable removes future registrations; rollback restores compatible previous code and configuration. These operations may execute arbitrary installed code. Do not edit protected installation storage directly. Business data belongs in Nexus.",
          input_schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["install", "check", "activate", "disable", "rollback"] },
              path: { type: "string" },
              name: { type: "string" },
              version: { type: "string" },
              configuration: { type: "object" },
            },
            required: ["action"],
            additionalProperties: false,
          },
          effect_profile: {
            kind: "write",
            destructive: true,
            effect_scope: "open",
            idempotency: "none",
            reconciliation: "lookup",
          },
          timeout_ms: 120000,
        },
        async execute(input, context) {
          context.signal.throwIfAborted()
          if (input.action === "install" && (typeof input.path !== "string" || !isAbsolute(input.path)))
            return { content: "install requires an absolute source path", is_error: true }
          const result = await owner
            .command({ ...input, action: "package." + input.action }, manager(), context.signal)
            .then(
              (result) => {
                const value = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(
                  JSON.stringify(result),
                )
                return {
                  content: JSON.stringify(value),
                  ...(value && typeof value === "object" && !Array.isArray(value) && value.passed === false
                    ? { is_error: true }
                    : {}),
                }
              },
              (error: unknown) => ({
                content: error instanceof Error ? error.message : "Package operation failed.",
                is_error: true,
              }),
            )
          return result
        },
      })
    },
  }
}
