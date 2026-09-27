import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("recordings release encoders and retained MP3 results", async () => {
  // Conservative JIT roots can retain dead async locals. Run collection assertions
  // in an isolated interpreter so they measure the recorder's ownership instead.
  const child = Bun.spawn(
    [process.execPath, "test", fileURLToPath(new URL("./fixture/audio-retention.ts", import.meta.url))],
    {
      env: { ...process.env, BUN_JSC_useJIT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(code, stdout + stderr).toBe(0)
})
