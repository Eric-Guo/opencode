import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bashOutput } from "../src/bash-output"

test("bash captures complete overflow and renders bounded line and byte tails with content-addressed spills", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "nexus-bash-"))
  const path = join(fixture, "output")
  const signal = new AbortController().signal
  try {
    await writeFile(path, "one\ntwo\n")
    expect(await bashOutput(path, signal)).toEqual({ content: "one\ntwo", spill: undefined, details: {} })
    const lines = Array.from({ length: 2100 }, (_, index) => "line " + (index + 1)).join("\n") + "\n"
    await writeFile(path, lines)
    const rendered = await bashOutput(path, signal, join(fixture, "artifacts"))
    expect(rendered.content).toStartWith("line 101\n")
    expect(rendered.details).toMatchObject({
      truncation: { truncated_by: "lines", output_lines: 2000, total_lines: 2100 },
    })
    expect(await readFile(rendered.spill!, "utf8")).toBe(lines)
    expect((await bashOutput(path, signal, join(fixture, "artifacts"))).spill).toBe(rendered.spill)
    await writeFile(path, "😀".repeat(100000))
    const giant = await bashOutput(path, signal)
    expect(giant.details).toMatchObject({
      truncation: { truncated_by: "bytes", last_line_partial: true, output_bytes: 51200 },
    })
    expect(giant.content).toStartWith("😀".repeat(12800))
    expect(giant.content).not.toContain("�")
    expect(await readFile(giant.spill!, "utf8")).toBe("😀".repeat(100000))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
