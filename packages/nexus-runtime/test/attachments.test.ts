import { expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { runClaim } from "../src/runner"
import { AcpClient } from "../src/acp"
import { acpFixture } from "./fixture/acp"
import { executorFixture } from "./fixture/executor"

test("delegation forwards ordered PDFs from the claim and captures only attachment metadata", async () => {
  const fixture = await executorFixture()
  const peer = await acpFixture()
  const client = new AcpClient(
    { pdf: peer.row({ env: { EMBEDDED_CONTEXT: "1" } }), plain: peer.row() },
    { storage: peer.storage },
  )
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const bytes = [Buffer.from("%PDF-1.7\nfirst\n"), Buffer.from("%PDF-1.7\nsecond\n")]
  const state = { mime: "application/pdf", size: bytes[1].length, truncated: false, denied: false }
  const reads: string[] = []
  const downloads: string[] = []
  const captures: string[] = []

  fixture.control.route = async (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname.endsWith("/executor/uploads")) {
      const file = (await request.formData()).get("upload[file]")
      if (!(file instanceof File)) throw new Error("Expected an ACP transcript.")

      captures.push(await file.text())
      return Response.json(
        {
          upload: {
            public_id: crypto.randomUUID(),
            filename: file.name,
            content_type: file.type,
            byte_size: file.size,
            created_at: new Date().toISOString(),
          },
        },
        { status: 201 },
      )
    }
    const match = /\/attachments\/([^/]+)(\/bytes)?$/.exec(pathname)
    if (!match) return
    expect(request.headers.get("Claim-Token")).toBe("claim-token")
    const id = match[1]
    if (match[2]) {
      downloads.push(id)
      return new Response(id === first ? bytes[0] : state.truncated ? bytes[1].subarray(0, 1) : bytes[1])
    }
    reads.push(id)
    if (id === second && state.denied)
      return Response.json({ error: { code: "not_found" } }, { status: 404 })

    return Response.json({
      upload: {
        public_id: id,
        filename: "fixture.pdf",
        content_type: id === first ? "application/pdf" : state.mime,
        byte_size: id === first ? bytes[0].length : state.size,
        created_at: new Date().toISOString(),
      },
    })
  }
  const signal = new AbortController().signal
  const tool = client.tool()!
  const run = (agent: string, attachments: string[], token?: string) =>
    runClaim(
      fixture.client,
      fixture.add("run", crypto.randomUUID(), "delegate_agent", {
        tool_input: { agent, prompt: "Read the PDFs", attachments },
      }),
      peer.work,
      signal,
      undefined,
      undefined,
      [tool],
      undefined,
      token,
    )
  try {
    expect(await run("plain", [first], "claim-token")).toMatchObject({
      is_error: true,
      content: expect.stringContaining("does not advertise embedded context"),
    })
    expect(await run("pdf", [first])).toMatchObject({
      is_error: true,
      content: expect.stringContaining("requires an active executor claim"),
    })
    expect(await run("pdf", ["file:///wrong.pdf"], "claim-token")).toMatchObject({
      is_error: true,
      content: expect.stringContaining("Nexus attachment reference or upload UUID"),
    })
    expect(reads).toEqual([])
    expect(downloads).toEqual([])

    for (const [change, downloadCount] of [
      [{ denied: true }, 0],
      [{ mime: "image/png" }, 0],
      [{ size: 0 }, 0],
      [{ size: 16 * 1024 * 1024 + 1 }, 0],
      [{ truncated: true }, 1],
    ] as const) {
      Object.assign(state, { mime: "application/pdf", size: bytes[1].length, truncated: false, denied: false }, change)
      downloads.length = 0
      expect(await run("pdf", [first, second], "claim-token")).toMatchObject({ is_error: true })
      expect(downloads).toHaveLength(1 + downloadCount)
    }
    expect(peer.events.filter((event) => event.event === "prompt")).toEqual([])

    bytes[1] = Buffer.alloc(16 * 1024 * 1024)
    bytes[1].write("%PDF-1.7\n")
    state.size = bytes[1].length
    state.truncated = false
    downloads.length = 0
    const result = await run("pdf", ["NEXUS://UPLOADS/" + second.toUpperCase(), first], "claim-token")
    expect(result.is_error).toBe(false)
    expect(downloads).toEqual([second, first])
    const selected = [second, first].map((id, index) => ({
      uri: "nexus://uploads/" + id,
      mimeType: "application/pdf",
      size: bytes[1 - index].length,
      sha256: createHash("sha256").update(bytes[1 - index]).digest("hex"),
    }))
    expect(peer.events.find((event) => event.event === "attachments")?.resources).toMatchObject(
      selected.map((entry) => ({ uri: entry.uri, mimeType: entry.mimeType, sha256: entry.sha256 })),
    )
    const frames = captures[0].trim().split("\n").map((line) => JSON.parse(line))
    const sent = frames.find((frame) => frame.direction === "out" && frame.message.method === "session/prompt")
    expect(sent.message.params.prompt).toEqual([
      { type: "text", text: "Read the PDFs" },
      ...selected.map((entry) => ({
        type: "resource",
        resource: { uri: entry.uri, mimeType: entry.mimeType, size: entry.size },
      })),
    ])
  } finally {
    await client.close()
    await peer.close()
    await fixture.close()
  }
})

test("attachments transfer whole large media, keep imports outside project files and preserve previous complete downloads", async () => {
  const fixture = await executorFixture()
  const signal = new AbortController().signal
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 65)
  const id = crypto.randomUUID()
  const upload = {
    public_id: id,
    filename: "report final.pdf",
    content_type: "application/pdf",
    byte_size: bytes.length,
    created_at: new Date().toISOString(),
  }
  const published: { type: string; hash: string }[] = []
  let incomplete = false
  fixture.control.route = async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/attachments/" + id)) {
      expect(request.headers.get("Claim-Token")).toBe("claim-token")
      return Response.json({ upload })
    }
    if (path.endsWith("/attachments/" + id + "/bytes")) return new Response(incomplete ? bytes.subarray(0, 10) : bytes)
    if (path.endsWith("/executor/uploads")) {
      const form = await request.formData()
      const file = form.get("upload[file]")
      if (!(file instanceof Blob)) throw new Error("Expected uploaded file")
      published.push({
        type: file.type,
        hash: createHash("sha256")
          .update(Buffer.from(await file.arrayBuffer()))
          .digest("hex"),
      })
      return Response.json({ upload }, { status: 201 })
    }
  }
  try {
    const row = fixture.add("run", "import", "file_import", {
      tool_input: { upload: "NEXUS://UPLOADS/" + id.toUpperCase() },
    })
    const artifacts = join(fixture.directory, "runtime-artifacts")
    const imported = await runClaim(
      fixture.client,
      row,
      fixture.directory,
      signal,
      undefined,
      undefined,
      [],
      undefined,
      "claim-token",
      undefined,
      undefined,
      artifacts,
    )
    const result = Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(imported.structured_content)
    expect(result.path).toBe(join(artifacts, id + "-report_final.pdf"))
    expect(Bun.file(result.path).size).toBe(bytes.length)
    expect(await Bun.file(join(fixture.directory, "nexus-attachments")).exists()).toBe(false)
    incomplete = true
    expect(
      await runClaim(
        fixture.client,
        row,
        fixture.directory,
        signal,
        undefined,
        undefined,
        [],
        undefined,
        "claim-token",
        undefined,
        undefined,
        artifacts,
      ),
    ).toMatchObject({ is_error: true })
    expect(await readdir(artifacts)).toEqual([id + "-report_final.pdf"])
    expect(Bun.file(result.path).size).toBe(bytes.length)
    await writeFile(join(fixture.directory, "image.png"), bytes)
    const read = fixture.add("run", "read", "read", { tool_input: { path: "image.png" } })
    expect(await runClaim(fixture.client, read, fixture.directory, signal)).toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: "resource_link" })]),
    })
    const publish = fixture.add("run", "publish", "file_publish", { tool_input: { path: result.path } })
    await runClaim(fixture.client, publish, fixture.directory, signal)
    expect(published).toEqual([
      { type: "image/png", hash: createHash("sha256").update(bytes).digest("hex") },
      { type: "application/pdf", hash: createHash("sha256").update(bytes).digest("hex") },
    ])
  } finally {
    await fixture.close()
  }
})

test("operator file capture preserves media type and metadata for paths outside the captured root", async () => {
  const fixture = await executorFixture()
  const root = join(fixture.directory, "project")
  const path = join(fixture.directory, "capture.png")
  await mkdir(root)
  await writeFile(path, "image bytes")
  const uploaded: string[] = []
  fixture.control.route = async (request) => {
    if (!new URL(request.url).pathname.endsWith("/executor/uploads")) return
    const file = (await request.formData()).get("upload[file]")
    if (!(file instanceof File)) throw new Error("Expected a file")
    uploaded.push(await file.text())
    return Response.json(
      {
        upload: {
          public_id: crypto.randomUUID(),
          filename: file.name,
          content_type: file.type,
          byte_size: file.size,
          created_at: new Date().toISOString(),
        },
      },
      { status: 201 },
    )
  }
  try {
    const row = fixture.add("run", "bytes", "files_bytes", { tool_input: { path: "../capture.png" } })
    expect(await runClaim(fixture.client, row, root, new AbortController().signal)).toMatchObject({
      content: [
        { type: "text", text: `${path} (image/png, 11 bytes)` },
        { type: "resource_link", name: "capture.png", mimeType: "image/png", size: 11 },
      ],
    })
    expect(uploaded).toEqual(["image bytes"])
  } finally {
    await fixture.close()
  }
})
