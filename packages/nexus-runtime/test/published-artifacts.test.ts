import { expect, test } from "bun:test"
import { publishedArtifacts } from "../src/published-artifacts"
import { storeFixture } from "./fixture/store"

const task = { kind: "tool_task", status: "completed", lifetime: "turn", wake: "immediate", after: [], waiting_on: [] }
const result = {
  conversation_public_id: "child",
  input_public_id: "input",
  turn_public_id: "turn",
  variant_public_id: "canonical",
  run_public_id: "child-run",
  requester_speaker_public_id: "speaker",
  status: "completed",
}
const variant = {
  public_id: "canonical",
  source: "original",
  status: "completed",
  run_public_id: "child-run",
  content: "/tmp/prose.txt",
  attachments: [{ public_id: "input-file", filename: "input.txt", content_type: "text/plain", byte_size: 8 }],
}

test("Published files follow canonical callback variants and ignore prose, input attachments and MCP impostors", async () => {
  const reads: string[] = []
  const service = storeFixture((request) => {
    const url = new URL(request.url)
    expect(url.searchParams.has("include_hidden")).toBe(false)
    const path = url.pathname
    reads.push(path)
    if (path.endsWith("/runs/child-run"))
      return Response.json({
        run: {
          public_id: "child-run",
          status: "completed",
          tasks: [
            { ...task, key: "capture", tool_name: "file_publish" },
            {
              ...task,
              key: "impostor",
              tool_name: "file_publish",
              target: { kind: "mcp", server: "remote", tool_name: "file_publish" },
            },
            { ...task, key: "prose", tool_name: "read" },
          ],
        },
      })
    if (path.endsWith("/tasks/capture"))
      return Response.json({
        task: {
          ...task,
          key: "capture",
          tool_name: "file_publish",
          content: [
            {
              type: "resource_link",
              uri: "nexus://uploads/output",
              name: "output.txt",
              mimeType: "text/plain",
              size: 10,
            },
            {
              type: "resource_link",
              uri: "file:///tmp/private.txt",
              name: "private.txt",
              mimeType: "text/plain",
              size: 10,
            },
            {
              type: "resource_link",
              uri: "nexus://uploads/output",
              name: "renamed.txt",
              mimeType: "text/plain",
              size: 10,
            },
            { type: "text", text: "nexus://uploads/prose" },
          ],
        },
      })
    if (path.endsWith("/turns/turn"))
      return Response.json({
        turn: {
          public_id: "turn",
          input_public_id: "input",
          position: 1,
          kind: "callback",
          role: "assistant",
          status: "completed",
          visibility: "visible",
          created_at: "2026-01-01T00:00:00Z",
          answering_user_public_id: "bot",
          active_variant: { ...variant, public_id: "later", run_public_id: "unrelated-run" },
          callback_sources: [
            {
              input_public_id: "callback",
              origin: "background",
              sender_conversation_public_id: "child",
              sender_run_public_id: "child-run",
              sender_task_key: "spawn",
              result,
            },
          ],
        },
      })
    if (path.endsWith("/turns/turn/variants/canonical"))
      return Response.json({ turn: { public_id: "turn", inherited: false }, variant })
  })
  try {
    expect(await publishedArtifacts(service.client, "workspace", { results: [result, result] })).toEqual([
      { public_id: "output", filename: "output.txt", content_type: "text/plain", byte_size: 10 },
    ])
    expect(reads.filter((path) => path.endsWith("/turns/turn"))).toHaveLength(1)
    expect(reads.some((path) => /impostor|unrelated-run|\/tasks\/prose/.test(path))).toBe(false)
  } finally {
    service.server.stop(true)
  }
})

test("Published native images require the kernel image tool's own graph expansion", async () => {
  const service = storeFixture((request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/runs/run"))
      return Response.json({
        run: {
          public_id: "run",
          status: "completed",
          tasks: [
            { ...task, key: "generate", tool_name: "image_generate" },
            { ...task, key: "image", kind: "inference", workload: "image_generation" },
            {
              ...task,
              key: "remote",
              tool_name: "image_generate",
              target: { kind: "mcp", server: "remote", tool_name: "image_generate" },
            },
            { ...task, key: "unrelated", kind: "inference", workload: "image_generation" },
          ],
        },
      })
    if (path.endsWith("/graph"))
      return Response.json({
        nodes: ["image", "unrelated"].map((key) => ({
          key,
          kind: "inference",
          status: "completed",
          visibility: "public",
          deliverable: true,
          lifetime: "turn",
          wake: "immediate",
          input_from: [],
          result_from: [],
          expansion_parent: key === "image" ? "generate" : "remote",
        })),
        edges: [],
        mermaid: "graph TD",
      })
    if (path.endsWith("/tasks/image"))
      return Response.json({
        task: {
          ...task,
          key: "image",
          kind: "inference",
          workload: "image_generation",
          content: [
            {
              type: "resource_link",
              uri: "nexus://uploads/generated",
              name: "image.png",
              mimeType: "image/png",
              size: 64,
            },
            {
              type: "resource_link",
              uri: "nexus://uploads/not-image",
              name: "text.txt",
              mimeType: "text/plain",
              size: 64,
            },
          ],
        },
      })
  })
  try {
    expect(await publishedArtifacts(service.client, "workspace", { run: "run" })).toEqual([
      { public_id: "generated", filename: "image.png", content_type: "image/png", byte_size: 64 },
    ])
  } finally {
    service.server.stop(true)
  }
})
