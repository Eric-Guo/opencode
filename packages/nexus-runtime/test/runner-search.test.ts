import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runnerSearch } from "../src/runner-search"

test("native runner search supports glob paths, literal case-insensitive matching, context and limits", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nexus-search-")))
  const signal = new AbortController().signal
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/file.ts"), "before\nA+B\na+b\nafter\n")
    await writeFile(join(root, "other.txt"), "A+B\n")
    await writeFile(join(root, ".gitignore"), "src/ignored.ts\n")
    await writeFile(join(root, "src/ignored.ts"), "ignored")
    const found = await runnerSearch(root, "find", { pattern: "src/**/*.ts" }, signal)
    if (Bun.which("fd") || Bun.which("fdfind")) expect(found.content).toBe("src/file.ts")
    else expect(found).toMatchObject({ is_error: true, content: expect.stringContaining("fd not found") })
    if (!Bun.which("rg")) {
      expect(await runnerSearch(root, "grep", { pattern: "a+b" }, signal)).toMatchObject({
        is_error: true,
        content: expect.stringContaining("not found on PATH"),
      })
      return
    }
    const matched = await runnerSearch(
      root,
      "grep",
      { pattern: "a+b", literal: true, ignoreCase: true, glob: "*.ts", context: 1, limit: 1 },
      signal,
    )
    expect(matched.content).toContain("src/file.ts-1- before")
    expect(matched.content).toContain("src/file.ts:2: A+B")
    expect(matched.content).toContain("1 matches limit reached")
    const direct = await runnerSearch(root, "grep", { pattern: "a+b", literal: true, path: "src/file.ts" }, signal)
    expect(direct.content).toContain("file.ts:3: a+b")
    await writeFile(join(root, "giant"), "match " + "a".repeat(60000) + "\nmatch small\n")
    const oversized = await runnerSearch(root, "grep", { pattern: "match", path: "giant" }, signal)
    expect(oversized.content).toContain("giant:2: match small")
    expect(oversized.structured_content).toMatchObject({ oversized_lines_skipped: 1 })
    await writeFile(join(root, "unicode"), "😀".repeat(501))
    const unicode = await runnerSearch(root, "grep", { pattern: "😀", path: "unicode" }, signal)
    expect(unicode.content).toContain("😀".repeat(500) + "... [truncated]")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
