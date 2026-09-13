import { expect, test } from "bun:test"
import { createRendererLoader } from "./renderer-loading"

test("the returned primary determines which renderer waits for window readiness", async () => {
  const loaded: string[] = []
  const errors: unknown[] = []
  const loader = createRendererLoader<string>((error) => errors.push(error))
  loader.add("opencode", async () => {
    loaded.push("secondary.html")
  })
  loader.add("custom-primary", async () => {
    loaded.push("custom.html")
  })
  expect(loaded).toEqual([])
  const primary = loader.primary("custom-primary")
  expect(loaded).toEqual(["secondary.html"])
  expect(primary).toBeDefined()
  await primary!()
  expect(loaded).toEqual(["secondary.html", "custom.html"])

  loader.add("lazy", async () => {
    loaded.push("lazy.html")
  })
  expect(loaded).toEqual(["secondary.html", "custom.html", "lazy.html"])
  expect(errors).toEqual([])
})

test("the base window uses the host's default load", () => {
  const loader = createRendererLoader<string>(() => {})
  expect(loader.primary("base")).toBeUndefined()
})

test("secondary failures reach logging and primary failures reach window readiness", async () => {
  const errors: unknown[] = []
  const loader = createRendererLoader<string>((error) => errors.push(error))
  loader.add("secondary", () => Promise.reject("secondary"))
  loader.add("primary", () => Promise.reject("primary"))
  const primary = loader.primary("primary")
  loader.add("lazy", () => Promise.reject("lazy"))
  await expect(primary!()).rejects.toBe("primary")
  expect(errors).toEqual(["secondary", "lazy"])
})
