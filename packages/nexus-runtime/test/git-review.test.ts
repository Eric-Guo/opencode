import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initRepo } from "../../core/test/fixture/git"
import { runnerEnvironment } from "../src/runner-environment"
import { gitReview } from "../src/runner-git"

test("Git review pins comparisons and bounds text/binary patches without touching the index", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nexus-review-")))
  const signal = new AbortController().signal
  try {
    await initRepo(directory)
    const environment = await runnerEnvironment(directory, [join(directory, "additional")])
    expect(environment.branch).toBeString()
    expect(environment.worktree).toBe(false)
    expect(environment.report).toContain("Additional directories: " + join(directory, "additional"))
    await writeFile(join(directory, "text"), "hello\n")
    await writeFile(join(directory, "binary"), Buffer.from([0, 255, 2]))
    await writeFile(join(directory, "huge"), "long line\n".repeat(5000))
    const review = await gitReview(directory, {}, signal)
    expect(review.structured_content?.files).toHaveLength(3)
    const base = review.structured_content!.base
    expect((await gitReview(directory, { base, path: "text" }, signal)).structured_content?.file).toMatchObject({
      state: "text",
      patch: expect.stringContaining("+hello"),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect((await gitReview(directory, { base, path: "binary" }, signal)).structured_content?.file).toMatchObject({
      state: "binary",
      patch: null,
    })
    expect((await gitReview(directory, { base, path: "huge" }, signal)).structured_content?.file).toMatchObject({
      state: "too_large",
      patch: null,
    })
    expect(await gitReview(directory, { base, path: "missing" }, signal)).toMatchObject({ is_error: true })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
