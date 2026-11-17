import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
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

// POSIX permits control characters in filenames; fd's NUL records must remain reversible.
test.skipIf(process.platform === "win32" || !(Bun.which("fd") || Bun.which("fdfind")))(
  "find escapes display records and budgets relative paths independently of the search root",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "nexus-find-paths-")))
    const root = join(base, ...Array.from({ length: 6 }, (_, i) => String(i) + "x".repeat(99)))
    const names = ["line\nbreak.txt", "literal\\n.txt", 'quote".txt', "tail .txt"]
    try {
      await mkdir(root, { recursive: true })
      await Promise.all(names.map((name) => writeFile(join(root, name), "")))
      await mkdir(join(root, "directory"))
      const escaped = await runnerSearch(root, "find", { pattern: "*.txt" }, new AbortController().signal)
      expect(String(escaped.content).split("\n").sort()).toEqual(
        names.map((name) => JSON.stringify(name).slice(1, -1)).sort(),
      )
      expect(escaped.structured_content).toMatchObject({ paths: expect.arrayContaining(names) })
      expect((await runnerSearch(root, "find", { pattern: "directory" }, new AbortController().signal)).content).toBe(
        "directory/",
      )
      const files = Array.from({ length: 100 }, (_, i) => "file-" + String(i).padStart(3, "0") + ".ts")
      await Promise.all(files.map((name) => writeFile(join(root, name), "")))
      const found = await runnerSearch(root, "find", { pattern: "*.ts" }, new AbortController().signal)
      expect(String(found.content).split("\n").sort()).toEqual(files)
      expect(found.structured_content).toMatchObject({ truncated: false, limit_reached: false })
      const limited = await runnerSearch(root, "find", { pattern: "*.ts", limit: 2 }, new AbortController().signal)
      expect(limited.structured_content).toMatchObject({ result_limit_reached: true, limit_reached: true })
      await Promise.all(Array.from({ length: 300 }, (_, i) => writeFile(join(root, "x".repeat(180) + i + ".big"), "")))
      const bounded = await runnerSearch(root, "find", { pattern: "*.big" }, new AbortController().signal)
      expect(bounded.structured_content).toMatchObject({
        truncated: true,
        limit_reached: false,
        truncation: { total_lines: 300, truncated_by: "bytes", max_bytes: 51200 },
      })
      expect(Buffer.byteLength(String(bounded.content).split("\n\n[")[0])).toBeLessThanOrEqual(51200)
      expect(bounded.content).toContain("50.0KB limit reached")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  },
)

// Search binaries may be operator wrappers. Their children belong to the same invocation.
for (const name of ["find", "grep"] as const)
  for (const mode of ["normal", "error", "limit", "cancel"] as const)
    test.skipIf(process.platform === "win32")(`${name} retires descendants after ${mode} exit`, async () => {
      await searchPeer(async (root) => {
        const controller = new AbortController()
        const record =
          name === "find"
            ? 'printf "%s\\0" "$PWD/a.txt"'
            : `printf '%s\\n' '{"type":"match","data":{"path":{"text":"${root}/a.txt"},"lines":{"text":"match"},"line_number":1}}'`
        await writeFile(
          join(root, name === "find" ? "fd" : "rg"),
          '#!/bin/bash\n/bin/sleep 30 </dev/null >/dev/null 2>&1 &\nprintf "%s" "$!" > "' +
            root +
            '/pid"\n' +
            (mode === "cancel"
              ? "wait\n"
              : (mode === "error" ? "" : record + "\n") +
                (mode === "limit" ? "wait\n" : "exit " + (mode === "error" ? 2 : 0) + "\n")),
          { mode: 0o755 },
        )
        const pending = runnerSearch(
          root,
          name,
          { pattern: "match", ...(mode === "limit" ? { limit: 1 } : {}) },
          controller.signal,
        )
        const pid = await readPid(root)
        try {
          if (mode === "cancel") {
            controller.abort(new Error("search canceled"))
            await expect(pending).rejects.toThrow("search canceled")
          }
          if (mode !== "cancel") {
            const result = await pending
            expect(Boolean(result.is_error)).toBe(mode === "error")
          }
          const deadline = Date.now() + 3000
          while (true) {
            const alive = (() => {
              try {
                return process.kill(pid, 0)
              } catch {
                return false
              }
            })()
            if (!alive || Date.now() >= deadline) {
              expect(alive).toBe(false)
              break
            }
            await Bun.sleep(5)
          }
        } finally {
          controller.abort()
          await pending.catch(() => {})
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }
      })
    })

for (const name of ["find", "grep"] as const)
  test.skipIf(process.platform === "win32")(`${name} bounds records and stderr independently`, async () => {
    await searchPeer(async (root) => {
      const file = join(root, name === "find" ? "fd" : "rg")
      await writeFile(
        file,
        `#!${process.execPath}\nprocess.stdout.write("x".repeat(51201) + ${JSON.stringify(name === "find" ? "\0" : "\n")})\n`,
        { mode: 0o755 },
      )
      const oversized = await runnerSearch(root, name, { pattern: "*" }, new AbortController().signal)
      if (name === "find")
        expect(oversized).toMatchObject({ is_error: true, content: "fd output record exceeded 51200 bytes" })
      if (name === "grep") expect(oversized.structured_content).toMatchObject({ oversized_lines_skipped: 1 })
      await writeFile(file, `#!${process.execPath}\nprocess.stderr.write("e".repeat(52224), () => process.exit(2))\n`)
      const failed = await runnerSearch(root, name, { pattern: "*" }, new AbortController().signal)
      expect(failed.is_error).toBe(true)
      expect(failed.content).toBe("e".repeat(51200) + "\n[stderr truncated after 51200 bytes]")
    })
  })

for (const name of ["find", "grep"] as const)
  test.skipIf(process.platform === "win32")(
    `${name} settles cancellation when a detached process retains stderr`,
    async () => {
      await searchPeer(async (root) => {
        await writeFile(join(root, "holder.js"), "setInterval(() => {}, 1000)\n")
        await writeFile(
          join(root, name === "find" ? "fd" : "rg"),
          `#!${process.execPath}
import { spawn } from "node:child_process"
const child = spawn(process.execPath, [${JSON.stringify(join(root, "holder.js"))}], {detached: true, stdio: ["ignore", "ignore", 2]})
await Bun.write(${JSON.stringify(join(root, "pid"))}, String(child.pid))
child.unref()
setInterval(() => {}, 1000)
`,
          { mode: 0o755 },
        )
        const controller = new AbortController()
        const pending = runnerSearch(root, name, { pattern: "match" }, controller.signal)
        const pid = await readPid(root)
        try {
          controller.abort(new Error("detached pipe canceled"))
          await expect(pending).rejects.toThrow("detached pipe canceled")
        } finally {
          controller.abort()
          process.kill(pid, "SIGKILL")
          await pending.catch(() => {})
        }
      })
    },
  )

async function searchPeer(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nexus-search-peer-")))
  const previous = process.env.PATH
  process.env.PATH = root + ":" + previous
  try {
    await run(root)
  } finally {
    process.env.PATH = previous
    await rm(root, { recursive: true, force: true })
  }
}

async function readPid(root: string) {
  const deadline = Date.now() + 3000
  while (true) {
    const pid = await readFile(join(root, "pid"), "utf8").catch(() => "")
    if (pid) return Number(pid)
    if (Date.now() >= deadline) throw new Error("Search peer did not start")
    await Bun.sleep(5)
  }
}

test("minified search dispatch runs in Node without Bun globals", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nexus-node-search-")))
  try {
    await writeFile(join(root, "plain.txt"), "needle\n")
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../src/runner-search.ts", import.meta.url))],
      outdir: root,
      naming: "[name].mjs",
      target: "node",
      format: "esm",
      minify: true,
    })
    expect(build.success).toBe(true)
    await writeFile(
      join(root, "smoke.mjs"),
      `
      import assert from "node:assert/strict"
      import { runnerSearch } from "./runner-search.mjs"
      assert.equal(typeof Bun, "undefined")
      const original = process.env.PATH
      process.env.PATH = ${JSON.stringify(root)}
      for (const name of ["find", "grep"]) {
        const missing = await runnerSearch(${JSON.stringify(root)}, name, {pattern:"needle"}, new AbortController().signal)
        assert.equal(missing.is_error, true)
        assert.match(missing.content, /not found/)
      }
      process.env.PATH = original
      if (${!!(Bun.which("fd") || Bun.which("fdfind"))}) {
        const found = await runnerSearch(${JSON.stringify(root)}, "find", {pattern:"plain.txt"}, new AbortController().signal)
        assert.equal(found.content, "plain.txt")
      }
      if (${!!Bun.which("rg")}) {
        const found = await runnerSearch(${JSON.stringify(root)}, "grep", {path:"plain.txt",pattern:"needle"}, new AbortController().signal)
        assert.match(found.content, /plain.txt:1: needle/)
      }
      console.log("Node search passed")
    `,
    )
    await using child = Bun.spawn([Bun.which("node") ?? "node", join(root, "smoke.mjs")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).not.toContain("Error:")
    expect(code).toBe(0)
    expect(stdout).toContain("Node search passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
