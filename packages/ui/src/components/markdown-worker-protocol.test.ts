import { expect, test } from "bun:test"
import { applyMarkdownWorkerResponse } from "./markdown-worker-protocol"

const token = (content: string): [string, string] => [content, ""]

test("accumulates stable worker tokens and replaces the unstable tail", () => {
  const first = applyMarkdownWorkerResponse(undefined, {
    type: "highlight",
    id: 1,
    key: "code",
    reset: true,
    stable: [token("one\n")],
    unstable: [token("tw")],
  })
  const second = applyMarkdownWorkerResponse(first, {
    type: "highlight",
    id: 2,
    key: "code",
    reset: false,
    stable: [token("two\n")],
    unstable: [token("three")],
  })

  expect(second.stable.map((item) => item[0])).toEqual(["one\n", "two\n"])
  expect(second.unstable.map((item) => item[0])).toEqual(["three"])
})

test("ignores stale worker responses and resets replacement streams", () => {
  const current = { id: 2, stable: [token("current")], unstable: [] }
  expect(
    applyMarkdownWorkerResponse(current, {
      type: "highlight",
      id: 1,
      key: "code",
      reset: false,
      stable: [token("stale")],
      unstable: [],
    }),
  ).toBe(current)

  expect(
    applyMarkdownWorkerResponse(current, {
      type: "highlight",
      id: 3,
      key: "code",
      reset: true,
      stable: [token("replacement")],
      unstable: [],
    }).stable.map((item) => item[0]),
  ).toEqual(["replacement"])
})
