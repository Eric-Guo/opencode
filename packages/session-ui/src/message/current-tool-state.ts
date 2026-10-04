import type { SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client/promise"
import { Option, Schema } from "effect"

export type ToolInput = Readonly<Record<string, Schema.Json | undefined>>

export type ToolMetadata = Readonly<Record<string, Schema.Json | undefined>>

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))

const isText = Schema.is(Schema.String)

const number = Schema.is(Schema.Number)

const failedCall = Schema.is(Schema.Struct({ status: Schema.Literal("error") }))

const deletedFile = Schema.is(Schema.Struct({ status: Schema.Literal("deleted") }))

const empty: ToolInput = Object.freeze({})

export function currentToolInput(tool: SessionMessageAssistantTool): ToolInput {
  if (tool.state.status !== "streaming") return tool.state.input

  return Option.getOrElse(decodeInput(tool.state.input), () => empty)
}

export function currentToolMetadata(tool: SessionMessageAssistantTool): ToolMetadata {
  if (!("metadata" in tool.state)) return empty

  return tool.state.metadata ?? empty
}

export function currentToolOutput(tool: SessionMessageAssistantTool) {
  if (tool.state.status === "running") {
    const output = tool.state.metadata.output

    return isText(output) ? output : undefined
  }

  if (!("content" in tool.state) || !tool.state.content) return undefined
  const text = tool.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")

  return text || undefined
}

export function currentToolError(tool: SessionMessageAssistantTool) {
  if (tool.state.status !== "error") return undefined

  return tool.state.error.message
}

export function currentToolFailed(tool: SessionMessageAssistantTool) {
  return (
    tool.state.status === "error" ||
    (tool.name === "execute" && executeToolFailed(currentToolMetadata(tool))) ||
    (tool.name === "shell" && tool.state.status === "completed" && shellResultFailed(currentToolMetadata(tool)))
  )
}

export function shellResultFailed(metadata: ToolMetadata) {
  // Shell completion reports the process outcome in metadata, not the tool status.
  return metadata.timeout === true || (number(metadata.exit) && metadata.exit !== 0)
}

export function executeToolFailed(metadata: ToolMetadata) {
  // Code Mode can report failed nested calls in a completed tool result.
  const calls = metadata.toolCalls

  return metadata.error === true || (Array.isArray(calls) && calls.some(failedCall))
}

export function currentToolHasLoadedFiles(tool: SessionMessageAssistantTool) {
  if (tool.name !== "read" || tool.state.status !== "completed") return false
  const loaded = tool.state.metadata?.loaded

  return Array.isArray(loaded) && loaded.some(isText)
}

export function readImagePath(input: ToolInput) {
  if (!isText(input.path) || !/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(input.path)) return

  return input.path.replaceAll("\\", "/")
}

// Plain file reads render as one comma-separated row; images and loaded instructions keep their own rows.
export function currentToolGroupedRead(tool: SessionMessageAssistantTool) {
  return (
    tool.name === "read" &&
    tool.state.status !== "error" &&
    !readImagePath(currentToolInput(tool)) &&
    !currentToolHasLoadedFiles(tool)
  )
}

export function currentContentDefaultOpen(
  content: SessionMessageAssistant["content"][number],
  shellExpanded: boolean,
  editExpanded: boolean,
) {
  if (content.type !== "tool") return undefined

  // Errored tools render the error card, which starts collapsed.
  if (content.state.status === "error") return false

  if (content.name === "shell" || content.name === "execute") return shellExpanded

  if (content.name === "patch") return editExpanded

  if (content.name !== "edit" && content.name !== "write") return undefined

  if (!editExpanded) return false
  const files = currentToolMetadata(content).files

  if (!Array.isArray(files) || files.length === 0) return true

  return !files.every(deletedFile)
}
