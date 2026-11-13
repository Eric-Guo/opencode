import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { Schema } from "effect"
import { definition, type RunnerTool } from "./extensions"
import { webSite } from "./web"

const Frame = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
})

// Chromium's debugging pipe is private to the spawned browser and needs no listening port.
async function openPage(executable: string, signal: AbortSignal) {
  const profile = await mkdtemp(join(tmpdir(), "opencode-nexus-browser-"))
  const chrome = spawn(
    executable,
    [
      "--headless",
      "--disable-background-networking",
      "--disable-sync",
      "--no-first-run",
      "--remote-debugging-pipe",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
      },
    },
  )
  const input = chrome.stdio[3]
  const output = chrome.stdio[4]
  if (!(input instanceof Writable) || !(output instanceof Readable)) {
    chrome.kill()
    throw new Error("Chromium debugging pipe unavailable.")
  }
  type Reply = NonNullable<typeof Frame.Type.result>
  const callbacks = new Map<number, { resolve(value: Reply): void; reject(reason: Error): void }>()
  let id = 0
  let buffer = ""
  const stop = () => {
    chrome.kill()
  }
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  const fail = () => {
    for (const item of callbacks.values()) item.reject(new Error("Browser closed."))
    callbacks.clear()
  }
  chrome.on("error", fail)
  input.on("error", fail)
  chrome.once("close", () => {
    fail()
    signal.removeEventListener("abort", stop)
    void rm(profile, { recursive: true, force: true }).catch(() => {})
  })
  output.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk
    if (buffer.length > 32 * 1024 * 1024) {
      fail()
      stop()
      return
    }
    let end: number
    while ((end = buffer.indexOf("\0")) >= 0) {
      const frame = Schema.decodeUnknownOption(Schema.fromJsonString(Frame))(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (frame._tag !== "Some" || !frame.value.id) continue
      const reply = callbacks.get(frame.value.id)
      callbacks.delete(frame.value.id)
      if (frame.value.error) reply?.reject(new Error(frame.value.error.message))
      else reply?.resolve(frame.value.result ?? {})
    }
  })
  const send = (method: string, params: object, sessionId?: string) =>
    new Promise<Reply>((resolve, reject) => {
      if (chrome.exitCode !== null || chrome.killed || !input.writable) return reject(new Error("Browser is closed."))
      const key = ++id
      callbacks.set(key, { resolve, reject })
      input.write(JSON.stringify({ id: key, method, params, sessionId }) + "\0")
    })
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" })
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
    if (typeof sessionId !== "string") throw new Error("Could not attach to browser page.")
    return { close: stop, command: (method: string, params: object) => send(method, params, sessionId) }
  } catch (error) {
    stop()
    throw error
  }
}

export function browserTools(executable: string, signal: AbortSignal): RunnerTool[] {
  const pages = new Map<string, Promise<Awaited<ReturnType<typeof openPage>>>>()
  const string = { type: "string" }
  const specs = [
    definition("browser_navigate", "Open an HTTP(S) page in this conversation's private browser.", { url: string }, [
      "url",
    ]),
    definition("browser_snapshot", "Read visible page text and controls.", {}, []),
    definition("browser_click", "Click the element matching a CSS selector.", { selector: string }, ["selector"]),
    definition("browser_type", "Replace a form field's value.", { selector: string, text: string }, [
      "selector",
      "text",
    ]),
    definition("browser_screenshot", "Capture the current page as a PNG.", {}, []),
    definition("browser_evaluate", "Evaluate JavaScript in the current page.", { expression: string }, ["expression"]),
  ]
  return specs.map((spec) => ({
    definition: spec,
    async execute(input, ctx) {
      if (!ctx.conversation) throw new Error("A conversation must own the browser.")
      const key = JSON.stringify([ctx.workspace, ctx.conversation])
      const state = pages.get(key) ?? openPage(executable, signal)
      pages.set(key, state)
      const close = () => {
        pages.delete(key)
        void state.then(
          (page) => page.close(),
          () => {},
        )
      }
      ctx.signal.addEventListener("abort", close, { once: true })
      try {
        ctx.signal.throwIfAborted()
        const page = await state
        if (spec.name === "browser_navigate") {
          webSite(input.url)
          const result = await page.command("Page.navigate", { url: input.url })
          if (result.errorText) throw new Error(String(result.errorText))
          return { content: "Opened " + input.url }
        }
        if (spec.name === "browser_screenshot") {
          const { data } = await page.command("Page.captureScreenshot", { format: "png" })
          if (typeof data !== "string") throw new Error("No screenshot returned.")
          if (!ctx.publish) throw new Error("Screenshot publication requires an active Nexus claim.")
          return {
            content: [
              await ctx.publish(new Blob([Buffer.from(data, "base64")], { type: "image/png" }), "screenshot.png"),
            ],
          }
        }
        const element = "document.querySelector(" + JSON.stringify(input.selector) + ")"
        const expression =
          spec.name === "browser_click"
            ? element + ".click()"
            : spec.name === "browser_type"
              ? "(()=>{const e=" +
                element +
                "; e.focus(); e.value=" +
                JSON.stringify(input.text) +
                ";e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()"
              : spec.name === "browser_snapshot"
                ? "({title:document.title,url:location.href,text:document.body.innerText.slice(0,32768),controls:Array.from(document.querySelectorAll('a,button,input,textarea,select')).slice(0,100).map(e=>({tag:e.localName,id:e.id,name:e.getAttribute('name'),label:e.getAttribute('aria-label')||e.innerText?.slice(0,120)}))})"
                : input.expression
        if (typeof expression !== "string") throw new Error("Expected a JavaScript expression.")
        const result = await page.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
        if (result.exceptionDetails) throw new Error("Page evaluation failed.")
        return { content: JSON.stringify(result.result).slice(0, 65536) }
      } catch (error) {
        close()
        throw error
      } finally {
        ctx.signal.removeEventListener("abort", close)
      }
    },
  }))
}
