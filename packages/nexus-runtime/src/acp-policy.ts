import type { RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk"
import { Schema } from "effect"
import { runnerRefusal } from "./runner-policy"
import type { RunnerContext } from "./extensions"
import type { AcpAgent } from "./acp-settings"

const Raw = Schema.Struct({
  command: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.Unknown),
})

export async function acpPermission(
  request: RequestPermissionRequest,
  tracked: ToolCallUpdate | undefined,
  agent: AcpAgent,
  cwd: string,
  protectedRoots: readonly string[],
  context?: RunnerContext,
): Promise<{ response: RequestPermissionResponse; refused: boolean }> {
  const call = {
    ...tracked,
    ...Object.fromEntries(Object.entries(request.toolCall).filter(([, value]) => value != null)),
  }
  const decoded = Schema.decodeUnknownOption(Raw)(call.rawInput ?? {})
  const raw = decoded._tag === "Some" ? decoded.value : {}
  const decodedCommand = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Array(Schema.String)]))(
    raw.command,
  )
  const command =
    decodedCommand._tag === "Some"
      ? typeof decodedCommand.value === "string"
        ? decodedCommand.value
        : decodedCommand.value.join(" ")
      : call.title
  const path = Schema.decodeUnknownOption(Schema.String)(raw.path)
  const paths = [
    ...new Set([...(call.locations?.map((entry) => entry.path) ?? []), ...(path._tag === "Some" ? [path.value] : [])]),
  ]
  const reason =
    call.kind === "execute" && command
      ? runnerRefusal("bash", { command }, cwd, protectedRoots)
      : ["edit", "delete", "move"].includes(call.kind ?? "")
        ? paths.map((path) => runnerRefusal("write", { path }, cwd, protectedRoots)).find((value) => value)
        : undefined
  const rejected = request.options.find((option) => option.kind === "reject_once")
  const once = request.options.find((option) => option.kind === "allow_once")
  const allow =
    !reason &&
    agent.permissions !== "reject" &&
    !!once &&
    (agent.permissions === "allow" ||
      (context?.ask &&
        (await context.ask(
          "acp_" + crypto.randomUUID(),
          JSON.stringify({ agent: agent.name, action: call.title, input: call.rawInput }, (_, value: unknown) =>
            typeof value === "string"
              ? agent.secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
              : value,
          ).slice(0, 8192),
          ["Allow once", "Deny"],
        )) === "Allow once"))
  const option = allow ? once : rejected
  return {
    response: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } },
    refused: !!reason,
  }
}
