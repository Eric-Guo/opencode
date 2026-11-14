import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { JsonObject } from "@cybros/agent"
import { browserTools } from "../src/browser"
import { BrowserSession, command, evaluate } from "../src/browser-session"
import type { RunnerContext } from "../src/extensions"

const chromium = process.env.OPENCODE_NEXUS_CHROMIUM

test("Browser readiness rejects an absent executable before any tool is published", async () => {
  const owner = new AbortController()
  const browser = new BrowserSession("/opencode-fixture/missing-chromium", owner.signal)
  try {
    await expect(browser.check()).rejects.toThrow("ENOENT")
  } finally {
    owner.abort()
    await browser.close()
  }
})

test.skipIf(!chromium)(
  "Browser loops share cookies, isolate tabs, serialize calls, and expire refs",
  async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          '<title>Fixture</title><label>Name<input id="name"></label><button onclick="document.title=document.querySelector(\'#name\').value">Save</button>',
          { headers: { "content-type": "text/html" } },
        ),
    })
    const owner = new AbortController()
    const clock = { now: 1000 }
    const browser = new BrowserSession(chromium!, owner.signal, { idle: 600000, now: () => clock.now })
    const tools = browserTools(chromium!, owner.signal, browser)
    const ctx: RunnerContext = {
      directory: tmpdir(),
      workspace: "workspace",
      conversation: "conversation",
      run: "first",
      task: "task",
      signal: owner.signal,
      publish: async (file, name) => {
        expect(file.type).toBe("image/png")
        expect(new Uint8Array(await file.slice(0, 8).arrayBuffer())).toEqual(
          new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        )
        return { type: "resource_link", uri: "nexus://uploads/fixture", name }
      },
    }
    const run = (name: string, args: JsonObject = {}, context = ctx) =>
      tools.find((tool) => tool.definition.name === name)!.execute(args, context)
    const ref = (content: unknown, role: string) => {
      const line = String(content)
        .split("\n")
        .find((line) => line.includes("- " + role))
      const found = line?.match(/\[ref=(e\d+_\d+)\]/)?.[1]
      expect(found).toBeString()
      return found!
    }
    try {
      await browser.check()
      const opened = await run("browser_navigate", { url: server.url.href })
      expect(opened.content).toContain("new browser tab")
      expect(opened.content).toContain("Fixture")
      const original = ref(opened.content, "textbox")
      const typed = await run("browser_type", { ref: original, text: "Saved fixture" })
      expect(typed.is_error).not.toBe(true)
      expect(typed.content).not.toContain("new browser tab")
      expect((await run("browser_click", { ref: original })).is_error).toBe(true)
      const clicked = await run("browser_click", { ref: ref(typed.content, "button") })
      expect(clicked.content).toContain("Title: Saved fixture")
      const cleared = await run("browser_type", { ref: ref(clicked.content, "textbox"), text: "" })
      expect(cleared.is_error).not.toBe(true)
      expect(
        (await run("browser_evaluate", { expression: "document.querySelector('input').value" })).structured_content,
      ).toBe("")
      expect(
        (await run("browser_evaluate", { expression: "document.cookie='login=shared'; document.title" }))
          .structured_content,
      ).toBe("Saved fixture")
      const second = { ...ctx, run: "second" }
      await run("browser_navigate", { url: server.url.href }, second)
      expect((await run("browser_evaluate", { expression: "document.cookie" }, second)).structured_content).toContain(
        "login=shared",
      )
      expect(
        (await run("browser_evaluate", { expression: "document.title='Second tab'; document.title" }, second))
          .structured_content,
      ).toBe("Second tab")
      expect((await run("browser_snapshot")).content).toContain("Title: Saved fixture")
      expect((await run("browser_screenshot")).content).toMatchObject([
        { type: "resource_link", name: "screenshot.png" },
      ])
      const gates = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const order: string[] = []
      const firstCall = browser.run("serial", owner.signal, async () => {
        started.resolve()
        await gates.promise
        order.push("first")
      })
      await started.promise
      const secondCall = browser.run("serial", owner.signal, async () => {
        order.push("second")
      })
      await browser.run("independent", owner.signal, async () => {
        order.push("independent")
      })
      expect(order).toEqual(["independent"])
      gates.resolve()
      await Promise.all([firstCall, secondCall])
      expect(order).toEqual(["independent", "first", "second"])
      const canceled = new AbortController()
      canceled.abort(new Error("canceled before admission"))
      await expect(
        browser.run("canceled", canceled.signal, async () => {
          throw new Error("must not run")
        }),
      ).rejects.toThrow("before admission")
      // Reaping uses an explicit clock, so neither idle retirement nor active-call protection waits ten minutes.
      clock.now += 600001
      const holding = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const busy = browser.run(JSON.stringify([ctx.workspace, ctx.run]), owner.signal, async () => {
        held.resolve()
        await holding.promise
      })
      await held.promise
      await browser.reap()
      holding.resolve()
      await busy
      expect((await run("browser_snapshot")).content).not.toContain("new browser tab")
      const replaced = await run("browser_snapshot", {}, second)
      expect(replaced.content).toContain("new browser tab")
      expect(replaced.content).toContain("about:blank")
    } finally {
      owner.abort()
      await browser.close()
      server.stop(true)
    }
  },
  15000,
) // Real Chromium startup, readiness probe, screenshots and several independent tabs.

test.skipIf(!chromium)(
  "Browser cancellation retires only its own tab and popups",
  async () => {
    const owner = new AbortController()
    const browser = new BrowserSession(chromium!, owner.signal)
    const canceled = new AbortController()
    try {
      await browser.run("other", owner.signal, async (tab) => {
        await evaluate(tab, "document.title='Other loop'")
      })
      const started = Promise.withResolvers<void>()
      const interrupted = browser.run("work", canceled.signal, async (tab) => {
        await evaluate(tab, "window.open('about:blank')")
        started.resolve()
        await evaluate(tab, "new Promise(()=>{})")
      })
      await started.promise
      canceled.abort(new Error("interrupt browser"))
      await expect(interrupted).rejects.toThrow("interrupt browser")
      expect(await browser.run("other", owner.signal, (tab) => evaluate(tab, "document.title"))).toBe("Other loop")
      expect(
        await browser.run("work", owner.signal, async (tab) => ({
          fresh: tab.fresh,
          title: await evaluate(tab, "document.title"),
        })),
      ).toEqual({ fresh: true, title: "" })
      // Browser-level discovery proves popup cleanup without relying on a second tool's page registry.
      const pages = await browser.run("other", owner.signal, (tab) => tab.driver.command("Target.getTargets"))
      expect((pages.targetInfos as JsonObject[]).filter((target) => target.type === "page")).toHaveLength(2)
      await browser.run("work", owner.signal, (tab) => command(tab, "Page.close"))
      expect(await browser.run("work", owner.signal, async (tab) => tab.fresh)).toBe(true)
    } finally {
      owner.abort()
      await browser.close()
    }
  },
  10000,
) // A real browser verifies cancellation, self-closure and nested target cleanup.
