import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
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
    const artifacts = await mkdtemp(join(tmpdir(), "nexus-browser-artifacts-"))
    const ctx: RunnerContext = {
      directory: tmpdir(),
      artifacts,
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
      const shot = await run("browser_screenshot")
      expect(shot.content).toMatchObject([
        { type: "text", text: expect.stringContaining("Saved a screenshot") },
        { type: "resource_link", name: expect.stringMatching(/^browser-[a-f0-9]{16}\.png$/) },
      ])
      expect(await readdir(artifacts)).toHaveLength(1)
      const data = await run(
        "browser_navigate",
        {
          url:
            "data:text/html," +
            encodeURIComponent(
              "<title>" + "t".repeat(400) + "</title><button>Still visible</button>" + "x".repeat(60000),
            ),
        },
        second,
      )
      expect(data.is_error).not.toBe(true)
      expect(String(data.content).split("\n")[0]).toContain("more bytes)")
      expect(String(data.content).split("\n")[1]).toContain("more bytes)")
      expect(data.content).toContain("Still visible")
      expect(Buffer.byteLength(String(data.content))).toBeLessThanOrEqual(51200)
      expect(data.content).toContain("snapshot truncated:")
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
      await rm(artifacts, { recursive: true, force: true })
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

test.skipIf(!chromium)(
  "Browser snapshots route refs into same-origin and isolated frames and reject covered controls",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        const path = new URL(request.url).pathname
        const html =
          path === "/frame"
            ? "<label>Frame field<input></label><button onclick=\"this.textContent='Frame clicked'\">Frame action</button>"
            : '<button style="position:absolute;left:0;top:0;width:150px;height:40px">Covered</button><div style="position:absolute;left:0;top:0;width:150px;height:40px;z-index:2">Overlay</div><iframe style="margin-top:70px" src="/frame"></iframe><iframe src="' +
              server.url.href.replace("127.0.0.1", "localhost") +
              'frame"></iframe>'
        return new Response(html, { headers: { "Content-Type": "text/html" } })
      },
    })
    const owner = new AbortController()
    const browser = new BrowserSession(chromium!, owner.signal, { actionTimeout: 50 })
    const tools = browserTools(chromium!, owner.signal, browser)
    const context: RunnerContext = {
      directory: tmpdir(),
      workspace: "fixture",
      conversation: "conversation",
      run: "frames",
      task: "task",
      signal: owner.signal,
    }
    const run = (name: string, input: JsonObject) =>
      tools.find((tool) => tool.definition.name === name)!.execute(input, context)
    const refs = (content: unknown, name: string) =>
      String(content)
        .split("\n")
        .filter((line) => line.includes(name))
        .map((line) => line.match(/\[ref=(e\d+_\d+)\]/)?.[1])
        .filter((ref): ref is string => !!ref)
    try {
      const opened = await run("browser_navigate", { url: server.url.href })
      expect(refs(opened.content, 'button "Frame action"')).toHaveLength(2)
      const covered = await run("browser_click", { ref: refs(opened.content, 'button "Covered"')[0] })
      expect(covered.is_error).toBe(true)
      expect(covered.content).toContain("covered")
      const same = await run("browser_click", { ref: refs(opened.content, 'button "Frame action"')[0] })
      expect(same.is_error).not.toBe(true)
      expect(refs(same.content, 'button "Frame clicked"')).toHaveLength(1)
      const other = await run("browser_click", { ref: refs(same.content, 'button "Frame action"')[0] })
      expect(other.is_error).not.toBe(true)
      expect(refs(other.content, 'button "Frame clicked"')).toHaveLength(2)
    } finally {
      owner.abort()
      await browser.close()
      server.stop(true)
    }
  },
  10000,
) // One isolated Chromium process exercises real out-of-process iframe input routing.
