import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRefCountMap } from "./refcount"

describe("createRefCountMap", () => {
  test("removes an item after its last owner is disposed", () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
    )
    const first = createRoot((dispose) => {
      map("/project")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("/project")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    expect(removed).toEqual(["/project"])
  })
})
