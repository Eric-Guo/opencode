import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { mutate, mutateEditor } from "../src/mutation"

test.each(["disk", "editor"])("a canceled %s mutation leaves the queue before its predecessor exits", async (kind) => {
  await using directory = await tmpdir()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const reason = new Error("queued mutation canceled")
  const calls: string[] = []
  const editor = {
    async read() {
      return "first"
    },
    async write(_path: string, content: string) {
      calls.push(content)
    },
  }
  const failure = new Error("checkpoint failed")
  const first = mutate(
    directory.path,
    "write",
    { path: "file", content: "first" },
    new AbortController().signal,
    async () => {
      entered.resolve()
      await release.promise
      throw failure
    },
  )
  const failed = first.catch((error: unknown) => error)

  await entered.promise

  const canceled = new AbortController()
  const second =
    kind === "disk"
      ? mutate(directory.path, "write", { path: "file", content: "canceled" }, canceled.signal)
      : mutateEditor(directory.path, "write", { path: "file", content: "canceled" }, canceled.signal, editor)
  const rejected = second.catch((error: unknown) => error)

  await mutateEditor(
    directory.path,
    "write",
    { path: "other", content: "independent" },
    new AbortController().signal,
    editor,
  )
  canceled.abort(reason)

  try {
    expect(await rejected).toBe(reason)
    expect(await Bun.file(join(directory.path, "file")).exists()).toBe(false)
    expect(calls).toEqual(["independent"])

    // Canceling a waiter must leave later work behind the actual holder.
    const third = mutateEditor(
      directory.path,
      "write",
      { path: "file", content: "third" },
      new AbortController().signal,
      editor,
    )

    await mutateEditor(
      directory.path,
      "write",
      { path: "other", content: "independent after cancellation" },
      new AbortController().signal,
      editor,
    )
    expect(calls).toEqual(["independent", "independent after cancellation"])

    release.resolve()
    expect(await failed).toBe(failure)
    await third
    expect(calls.at(-1)).toBe("third")
    await mutate(directory.path, "write", { path: "file", content: "after failure" }, new AbortController().signal)
    expect(await Bun.file(join(directory.path, "file")).text()).toBe("after failure")
  } finally {
    release.resolve()
    await first.catch(() => {})
    await second.catch(() => {})
  }
})

test("active editor mutations retain ownership until the editor exits after cancellation", async () => {
  await using directory = await tmpdir()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owner = new AbortController()
  const reason = new Error("active editor canceled")
  const calls: string[] = []
  const editor = {
    async read() {
      return "first"
    },
    async write(_path: string, content: string) {
      calls.push(content)
      if (content !== "first") return

      entered.resolve()
      await release.promise
      throw reason
    },
  }
  const first = mutateEditor(directory.path, "write", { path: "file", content: "first" }, owner.signal, editor)
  const rejected = first.catch((error: unknown) => error)

  await entered.promise
  owner.abort(reason)

  const second = mutateEditor(
    directory.path,
    "write",
    { path: "file", content: "second" },
    new AbortController().signal,
    editor,
  )

  try {
    await mutateEditor(
      directory.path,
      "write",
      { path: "other", content: "independent" },
      new AbortController().signal,
      editor,
    )
    expect(calls).toEqual(["first", "independent"])
  } finally {
    release.resolve()
    expect(await rejected).toBe(reason)
    await second
  }

  expect(calls).toEqual(["first", "independent", "second"])
})
