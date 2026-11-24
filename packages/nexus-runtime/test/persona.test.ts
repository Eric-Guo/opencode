import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { runPersona } from "../src/persona"
import { NexusRuntime } from "../src/runtime"
import { atomic } from "../src/storage"

test("persona commands use the signed-in Human, preserve authored bytes and distinguish an absent document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-persona-"))
  const runtime = new NexusRuntime(directory)
  const methods: string[] = []
  let content: string | null = null
  let absentCode = "prompt_document_not_found"
  using peer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/oauth/token")
        return Response.json({
          plane: "platform",
          scope: "application",
          user: { public_id: "human", display_name: "Human", role: "member" },
          token_type: "Bearer",
          refresh_token: "refresh",
          access_token: "platform",
          expires_in: 3600,
        })
      expect(request.headers.get("authorization")).toBe("Bearer platform")
      if (path === "/api/v1/profile")
        return Response.json({
          member: { public_id: "human", role: "member", kind: "human" },
          credential_plane: "platform",
        })
      expect(path).toBe("/api/v1/persona")
      methods.push(request.method)
      if (request.method === "PUT") {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ prompt_document: Schema.Struct({ content: Schema.String }) }),
        )(await request.json())
        content = body.prompt_document.content
      }
      if (content === null) return Response.json({ error: { code: absentCode } }, { status: 404 })
      if (request.method === "DELETE") {
        content = null
        return new Response(null, { status: 204 })
      }
      return Response.json({
        prompt_document: {
          slot: "persona",
          role: "system",
          content,
          bytesize: Buffer.byteLength(content),
          version: 1,
          written_at: "now",
        },
      })
    },
  })
  const cli = (args: string[], json = false, stdin?: AsyncIterable<Uint8Array>) =>
    runPersona(args, json, (command) => runtime.manage(command), stdin)

  try {
    await atomic(join(directory, "settings.json"), {
      origin: peer.url.origin,
      identifier: "opencode.fixture",
      directory,
      workspace: "",
      model: "provider/model",
    })
    await runtime.restore()
    await expect(cli([])).rejects.toThrow("Human")
    const url = new URL(await runtime.login())
    const callback = new URL(url.searchParams.get("redirect_uri")!)
    callback.searchParams.set("state", url.searchParams.get("state")!)
    callback.searchParams.set("code", "fixture")
    expect((await fetch(callback)).status).toBe(200)
    expect(await cli([])).toBe("No persona is set.\n")
    expect(await cli(["reset"], true)).toBe("null\n")
    const file = Bun.file(join(directory, "persona.txt"))
    const authored = "\uFEFF你好\r\n{{user}}\n"
    await Bun.write(file, authored)
    expect(JSON.parse(await cli(["set", file.name!], true)).content).toBe(authored)
    expect(await cli(["show"])).toBe(authored)
    const full = "界".repeat(21845) + "x"
    await Bun.write(file, full)
    expect(JSON.parse(await cli(["set", "-"], true, file.stream())).content).toBe(full)
    expect(JSON.parse(await cli(["reset"], true))).toEqual({ reset: true })
    expect(await cli(["show"], true)).toBe("null\n")
    await Bun.write(file, full + "x")
    await expect(cli(["set", "-"], false, file.stream())).rejects.toThrow("64 KiB")
    await expect(runtime.manage({ action: "persona.write", content: full + "x" })).rejects.toThrow("64 KiB")
    await Bun.write(file, Uint8Array.of(255))
    await expect(cli(["set", file.name!])).rejects.toThrow()
    await expect(cli(["set"])).rejects.toThrow("Use opencode nexus persona")
    absentCode = "unknown_route"
    await expect(cli(["show"])).rejects.toMatchObject({ status: 404, code: absentCode })
    await expect(cli(["reset"])).rejects.toMatchObject({ status: 404, code: absentCode })
    expect(methods).toEqual(["GET", "DELETE", "PUT", "GET", "PUT", "DELETE", "GET", "GET", "DELETE"])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
