import { expect, test } from "bun:test"
import { memoryContext } from "../src/speakers"

test("owner and external conversations share the speaker binding and default to index mode", () => {
  const own = memoryContext()
  const external = memoryContext({ audience: "external" })
  const full = memoryContext({ mode: "full" })

  expect(own.mode).toBe("index")
  expect(external.mode).toBe("index")
  expect("mode" in full).toBe(false)
  expect(own.bindings.map((row) => row.name)).toEqual(["conversation", "speaker", "agent", "workspace"])
  expect(external.bindings.map((row) => row.name)).toEqual(["conversation", "speaker", "workspace"])
  expect(external.bindings[1]).toEqual(own.bindings[1])
  expect(external.bindings.at(-1)?.access).toBe("read")
  expect(() => memoryContext({ audience: "unknown" })).toThrow("unknown Bot audience")
  expect(() => memoryContext({ mode: "unknown" })).toThrow("unknown memory mode")
})

test("a pinned speaker is embedded in the speaker binding source", () => {
  expect(memoryContext({ speaker: "speaker-1" }).bindings[1].source).toEqual({
    scope: "speaker",
    speaker_public_id: "speaker-1",
  })
  expect(memoryContext({ speaker: "" }).bindings[1].source).toEqual({ scope: "speaker" })
})
