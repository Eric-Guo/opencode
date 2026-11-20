import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { desktopBrowserTools, type DesktopBrowser } from "../src/desktop-browser"
import type { RunnerContext } from "../src/extensions"

test("Desktop Browser serializes commands per conversation and targets only its own tab", async () => {
  const owner = new AbortController()
  const calls: Array<[string, JsonObject]> = []
  const opened = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const browser: DesktopBrowser = async (operation, input) => {
    calls.push([operation, input])

    if (operation === "tabs_open" && calls.length === 1) {
      opened.resolve()
      await release.promise
      return { output: { id: "tab-first" }, content: [] }
    }
    if (operation === "tabs_open") return { output: { id: "tab-second" }, content: [] }
    if (operation === "snapshot") return { output: { content: String(input.tabID) }, content: [] }

    return { content: [] }
  }
  const desktop = desktopBrowserTools(browser, owner.signal, 600000)
  const context: RunnerContext = {
    workspace: "workspace",
    conversation: "first",
    run: "run-a",
    task: "task",
    directory: process.cwd(),
    signal: owner.signal,
  }
  const navigate = desktop.tools.find((tool) => tool.definition.name === "browser_navigate")!
  const click = desktop.tools.find((tool) => tool.definition.name === "browser_click")!

  try {
    const first = navigate.execute({ url: "https://example.test/" }, context)
    await opened.promise
    const next = click.execute({ ref: "e1" }, { ...context, run: "run-b" })
    const second = await navigate.execute({ url: "https://example.test/other" }, { ...context, conversation: "second" })

    expect(second.content).toContain("tab-second")
    expect(calls).toEqual([
      ["tabs_open", {}],
      ["tabs_open", {}],
      ["navigate", { tabID: "tab-second", url: "https://example.test/other" }],
      ["snapshot", { tabID: "tab-second" }],
    ])

    release.resolve()
    expect((await first).content).toContain("tab-first")
    expect((await next).content).toContain("tab-first")
    expect(calls.slice(4)).toEqual([
      ["navigate", { tabID: "tab-first", url: "https://example.test/" }],
      ["snapshot", { tabID: "tab-first" }],
      ["click", { tabID: "tab-first", ref: "e1" }],
      ["snapshot", { tabID: "tab-first" }],
    ])
  } finally {
    release.resolve()
    owner.abort()
    await desktop.close()
  }

  expect(calls.slice(-2)).toEqual([
    ["tabs_close", { tabID: "tab-first" }],
    ["tabs_close", { tabID: "tab-second" }],
  ])
})

test("A closed desktop tab does not replay an action or move it to another tab", async () => {
  const owner = new AbortController()
  const calls: Array<[string, JsonObject]> = []
  const browser: DesktopBrowser = async (operation, input) => {
    calls.push([operation, input])

    if (operation === "tabs_open") return { output: { id: "tab-" + calls.length }, content: [] }
    if (operation === "snapshot") return { output: { content: String(input.tabID) }, content: [] }
    if (operation === "click") throw new Error("[browser.tab_unavailable] The tab was closed.")

    return { content: [] }
  }
  const desktop = desktopBrowserTools(browser, owner.signal, 600000)
  const context: RunnerContext = {
    workspace: "workspace",
    conversation: "first",
    run: "run",
    task: "task",
    directory: process.cwd(),
    signal: owner.signal,
  }
  const navigate = desktop.tools.find((tool) => tool.definition.name === "browser_navigate")!
  const click = desktop.tools.find((tool) => tool.definition.name === "browser_click")!

  try {
    await navigate.execute({ url: "https://example.test/" }, context)
    expect(await click.execute({ ref: "e1" }, context)).toMatchObject({ is_error: true })
    expect(await click.execute({ ref: "e1" }, context)).toMatchObject({ is_error: true })
    expect(calls.slice(3)).toEqual([["click", { tabID: "tab-1", ref: "e1" }]])
    expect((await navigate.execute({ url: "https://example.test/other" }, context)).content).toContain("tab-5")
  } finally {
    owner.abort()
    await desktop.close()
  }
})
