import { expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { runClaim } from "../src/runner"
import { executorFixture } from "./fixture/executor"

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
