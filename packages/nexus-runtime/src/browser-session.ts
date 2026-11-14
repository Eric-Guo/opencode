import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"

const Frame = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  method: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
})
const Targets = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({ targetId: Schema.String, type: Schema.String, openerId: Schema.optional(Schema.String) }),
  ),
})
const Accessibility = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      nodeId: Schema.String,
      ignored: Schema.Boolean,
      role: Schema.optional(Schema.Struct({ value: Schema.String })),
      name: Schema.optional(Schema.Struct({ value: Schema.String })),
      value: Schema.optional(Schema.Struct({ value: Schema.MutableJson })),
      backendDOMNodeId: Schema.optional(Schema.Number),
      childIds: Schema.optional(Schema.Array(Schema.String)),
      properties: Schema.optional(
        Schema.Array(
          Schema.Struct({ name: Schema.String, value: Schema.Struct({ value: Schema.optional(Schema.MutableJson) }) }),
        ),
      ),
    }),
  ),
})
const Remote = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.MutableJson), description: Schema.optional(Schema.String) }),
  exceptionDetails: Schema.optional(
    Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(Schema.Struct({ description: Schema.optional(Schema.String) })),
    }),
  ),
})

/** A private Chromium pipe, shared by this extension's tabs; no public debugging socket. */
async function launch(executable: string) {
  const profile = await mkdtemp(join(tmpdir(), "opencode-nexus-browser-"))
  const chrome = spawn(
    executable,
    [
      "--headless",
      "--disable-background-networking",
      "--disable-sync",
      "--no-first-run",
      "--no-startup-window",
      "--remote-debugging-pipe",
      "--user-data-dir=" + profile,
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
      },
    },
  )
  await new Promise<void>((resolve, reject) => {
    chrome.once("spawn", resolve)
    chrome.once("error", reject)
  }).catch(async (error: unknown) => {
    await rm(profile, { recursive: true, force: true })
    throw error
  })
  const input = chrome.stdio[3]
  const output = chrome.stdio[4]
  if (!(input instanceof Writable) || !(output instanceof Readable)) {
    chrome.kill()
    await rm(profile, { recursive: true, force: true })
    throw new Error("Chromium debugging pipe unavailable.")
  }
  const callbacks = new Map<number, { method: string; resolve(value: JsonObject): void; reject(reason: Error): void }>()
  const listeners = new Set<(frame: typeof Frame.Type) => void>()
  const state = { id: 0, buffer: "", stderr: "", closed: false }
  const fail = (error: Error) => {
    state.closed = true
    callbacks.forEach((callback) => callback.reject(error))
    callbacks.clear()
  }
  chrome.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-4096)
  })
  chrome.on("error", fail)
  input.on("error", fail)
  const exited = new Promise<void>((resolve) =>
    chrome.once("close", () => {
      fail(new Error("Chromium closed. " + state.stderr))
      resolve()
    }),
  )
  output.setEncoding("utf8").on("data", (chunk: string) => {
    state.buffer += chunk
    if (state.buffer.length > 32 * 1024 * 1024) {
      fail(new Error("Chromium response exceeds 32 MiB."))
      chrome.kill("SIGKILL")
      return
    }
    let end: number
    while ((end = state.buffer.indexOf("\0")) >= 0) {
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Frame))(state.buffer.slice(0, end))
      state.buffer = state.buffer.slice(end + 1)
      if (parsed._tag !== "Some") continue
      const frame = parsed.value
      if (frame.id) {
        const reply = callbacks.get(frame.id)
        callbacks.delete(frame.id)
        if (frame.error) reply?.reject(new Error(reply.method + ": " + frame.error.message))
        else reply?.resolve(frame.result ?? {})
      }
      listeners.forEach((listener) => listener(frame))
    }
  })
  const command = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<JsonObject>((resolve, reject) => {
      if (state.closed || chrome.exitCode !== null || chrome.killed || !input.writable)
        return reject(new Error("Chromium is closed. " + state.stderr))
      const id = ++state.id
      callbacks.set(id, { method, resolve, reject })
      input.write(JSON.stringify({ id, method, params, sessionId }) + "\0")
    })
  const close = async () => {
    if (chrome.exitCode === null && !state.closed) chrome.kill()
    await abortable(exited, AbortSignal.timeout(3000)).catch(() => chrome.kill("SIGKILL"))
    await exited
    await rm(profile, { recursive: true, force: true })
  }
  await abortable(command("Browser.getVersion"), AbortSignal.timeout(60000)).catch(async (error: unknown) => {
    await close()
    throw error
  })
  return { command, listeners, close, alive: () => !state.closed && chrome.exitCode === null && !chrome.killed }
}

type Driver = Awaited<ReturnType<typeof launch>>
type Tab = {
  driver: Driver
  target: string
  session: string
  busy: boolean
  fresh: boolean
  last: number
  revision: number
  actionTimeout: number
  refs: Map<string, { node: number; session: string }>
  frames: Map<string, string>
  loaded: Set<string>
  loading: boolean
  closed: boolean
  listeners: Set<() => void>
  receive(frame: typeof Frame.Type): void
}

export class BrowserSession {
  private driver?: Promise<Driver>
  private readonly tabs = new Map<string, Tab>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly timer: ReturnType<typeof setInterval>
  private last = 0
  private opening = 0
  private reaping = false
  private closed = false
  private closing?: Promise<void>
  private readonly now: () => number
  private readonly idle: number

  constructor(
    private readonly executable: string,
    private readonly signal: AbortSignal,
    private readonly options: { idle?: number; callTimeout?: number; actionTimeout?: number; now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.idle = options.idle ?? 600000
    this.timer = setInterval(
      () => {
        void this.reap().catch(() => {})
      },
      Math.max(10, Math.min(this.idle / 4, 15000)),
    )
    this.timer.unref()
    signal.addEventListener(
      "abort",
      () => {
        void this.close().catch(() => {})
      },
      { once: true },
    )
  }

  /** Run before publishing tools; an ordinary session still starts only on first use. */
  async check() {
    this.signal.throwIfAborted()
    const driver = await launch(this.executable)
    await driver.close()
    this.signal.throwIfAborted()
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    clearInterval(this.timer)
    const driver = this.driver
    this.driver = undefined
    this.tabs.clear()
    this.closing = driver ? driver.then((driver) => driver.close()) : Promise.resolve()
    return this.closing
  }

  run<A>(owner: string, signal: AbortSignal, call: (tab: Tab, signal: AbortSignal) => Promise<A>) {
    const bounded = AbortSignal.any([
      signal,
      this.signal,
      AbortSignal.timeout((this.options.callTimeout ?? 60000) + 20000),
    ])
    const previous = this.queues.get(owner) ?? Promise.resolve()
    const pending = previous.then(async () => {
      bounded.throwIfAborted()
      const driver = await abortable(this.ensure(), bounded)
      bounded.throwIfAborted()
      const known = this.tabs.get(owner)
      if (known) known.busy = true
      try {
        if (known && !known.closed) {
          await abortable(driver.command("Target.getTargetInfo", { targetId: known.target }), bounded).catch(
            (error: unknown) => {
              if (!(error instanceof Error) || !error.message.includes("No target")) throw error
              known.closed = true
            },
          )
        }
        if (known?.closed) await this.drop(owner, known)
        const tab =
          this.tabs.get(owner) ??
          (await abortable(this.create(owner, driver, bounded), bounded).catch(async (error: unknown) => {
            await this.stop(driver)
            throw error
          }))
        const active = AbortSignal.any([bounded, AbortSignal.timeout(this.options.callTimeout ?? 60000)])
        const cancel = () => {
          void this.drop(owner, tab).catch(() => {})
        }
        tab.busy = true
        active.addEventListener("abort", cancel, { once: true })
        try {
          active.throwIfAborted()
          const value = await abortable(call(tab, active), active)
          tab.fresh = false
          return value
        } catch (error) {
          if (!driver.alive()) await this.stop(driver)
          // Argument and page errors are readable outcomes; cancellation must preserve a fresh-tab notice.
          if (!active.aborted) tab.fresh = false
          throw error
        } finally {
          active.removeEventListener("abort", cancel)
          tab.busy = false
          this.last = tab.last = this.now()
        }
      } finally {
        if (known) known.busy = false
      }
    })
    const tail = pending.then(
      () => {},
      () => {},
    )
    this.queues.set(owner, tail)
    void tail.then(() => {
      if (this.queues.get(owner) === tail) this.queues.delete(owner)
    })
    return abortable(pending, bounded)
  }

  async reap() {
    if (this.reaping || !this.driver || this.opening) return
    this.reaping = true
    try {
      const driver = await this.driver
      const idle = [...this.tabs.entries()].filter(([, tab]) => !tab.busy && this.now() - tab.last >= this.idle)
      if (![...this.tabs.values()].some((tab) => tab.busy) && this.now() - this.last >= this.idle) {
        await this.stop(driver)
        return
      }
      await Promise.all(idle.map(([owner, tab]) => this.drop(owner, tab)))
      if (this.opening) return
      const targets = Schema.decodeUnknownSync(Targets)(
        await abortable(driver.command("Target.getTargets"), AbortSignal.timeout(3000)).catch(
          async (error: unknown) => {
            await this.stop(driver)
            throw error
          },
        ),
      )
      if (this.opening) return
      const roots = new Set([...this.tabs.values()].filter((tab) => tab.driver === driver).map((tab) => tab.target))
      const parents = new Map(targets.targetInfos.map((target) => [target.targetId, target.openerId]))
      const owned = (id: string): boolean => roots.has(id) || (!!parents.get(id) && owned(parents.get(id)!))
      await Promise.all(
        targets.targetInfos
          .filter((target) => target.type === "page" && !owned(target.targetId))
          .map((target) => closeTarget(driver, target.targetId)),
      )
    } finally {
      this.reaping = false
    }
  }

  private async ensure() {
    if (this.closed) throw new Error("The browser session is closed.")
    this.signal.throwIfAborted()
    const current = this.driver
    if (current) {
      const driver = await current
      if (driver.alive()) return driver
      await this.stop(driver)
    }
    const starting = launch(this.executable)
    this.driver = starting
    this.last = this.now()
    return starting
      .catch((error: unknown) => {
        if (this.driver === starting) this.driver = undefined
        throw error
      })
      .then(async (driver) => {
        if (this.signal.aborted) {
          await driver.close()
          this.signal.throwIfAborted()
        }
        return driver
      })
  }

  private async create(owner: string, driver: Driver, signal: AbortSignal) {
    this.opening++
    try {
      const target = Schema.decodeUnknownSync(Schema.Struct({ targetId: Schema.String }))(
        await driver.command("Target.createTarget", { url: "about:blank" }),
      )
      const attached = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(
        await driver.command("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
      )
      const tab: Tab = {
        driver,
        target: target.targetId,
        session: attached.sessionId,
        busy: false,
        fresh: true,
        last: this.now(),
        revision: 0,
        actionTimeout: this.options.actionTimeout ?? 10000,
        refs: new Map(),
        frames: new Map(),
        loaded: new Set(),
        loading: false,
        closed: false,
        listeners: new Set(),
        receive(frame) {
          if (
            (frame.method === "Target.detachedFromTarget" && frame.params?.sessionId === tab.session) ||
            (frame.method === "Target.targetDestroyed" && frame.params?.targetId === tab.target)
          )
            tab.closed = true
          if (
            frame.method === "Target.attachedToTarget" &&
            (frame.sessionId === tab.session || [...tab.frames.values()].includes(frame.sessionId ?? ""))
          ) {
            const attached = Schema.decodeUnknownSync(
              Schema.Struct({
                sessionId: Schema.String,
                targetInfo: Schema.Struct({ type: Schema.String, targetId: Schema.String }),
              }),
            )(frame.params)
            if (attached.targetInfo.type === "iframe") {
              tab.frames.set(attached.targetInfo.targetId, attached.sessionId)
              void driver
                .command(
                  "Target.setAutoAttach",
                  { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
                  attached.sessionId,
                )
                .catch(() => {})
            }
          }
          if (frame.method === "Target.detachedFromTarget" && typeof frame.params?.sessionId === "string")
            tab.frames.forEach((session, id) => {
              if (session === frame.params?.sessionId) tab.frames.delete(id)
            })
          if (frame.sessionId !== tab.session && ![...tab.frames.values()].includes(frame.sessionId ?? "")) return
          if (frame.method === "Page.frameStartedLoading") tab.loading = true
          if (frame.method === "Page.frameStoppedLoading") tab.loading = false
          if (
            frame.method === "Page.lifecycleEvent" &&
            frame.params?.name === "load" &&
            typeof frame.params.loaderId === "string"
          )
            tab.loaded.add(frame.params.loaderId)
          if (frame.method === "Page.frameNavigated") tab.refs.clear()
          tab.listeners.forEach((listener) => listener())
        },
      }
      driver.listeners.add(tab.receive)
      this.tabs.set(owner, tab)
      await driver.command(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        tab.session,
      )
      await driver.command("Page.enable", {}, tab.session)
      await driver.command("Page.setLifecycleEventsEnabled", { enabled: true }, tab.session)
      if (signal.aborted) {
        await this.drop(owner, tab)
        signal.throwIfAborted()
      }
      return tab
    } finally {
      this.opening--
    }
  }

  private async stop(driver: Driver) {
    if ((await this.driver) !== driver) return
    this.driver = undefined
    this.tabs.forEach((tab, owner) => {
      if (tab.driver === driver) this.tabs.delete(owner)
    })
    await driver.close()
  }

  private async drop(owner: string, tab: Tab) {
    if (this.tabs.get(owner) !== tab) return
    this.tabs.delete(owner)
    tab.driver.listeners.delete(tab.receive)
    tab.listeners.forEach((listener) => listener())
    const close = async () => {
      const targets = Schema.decodeUnknownSync(Targets)(await tab.driver.command("Target.getTargets"))
      const parents = new Map(targets.targetInfos.map((target) => [target.targetId, target.openerId]))
      const owned = (id: string): boolean => id === tab.target || (!!parents.get(id) && owned(parents.get(id)!))
      await Promise.all(
        targets.targetInfos
          .filter((target) => owned(target.targetId))
          .map((target) => closeTarget(tab.driver, target.targetId)),
      )
    }
    await abortable(close(), AbortSignal.timeout(3000)).catch(() => this.stop(tab.driver))
  }
}

export async function command(tab: Tab, method: string, params: object = {}, session = tab.session) {
  const result = await tab.driver.command(method, params, session)
  if (method === "Page.close") tab.closed = true
  return result
}

function closeTarget(driver: Driver, target: string) {
  return driver.command("Target.closeTarget", { targetId: target }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.includes("No target")) throw error
  })
}

export async function evaluate(tab: Tab, expression: string) {
  const reply = Schema.decodeUnknownSync(Remote)(
    await command(tab, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
  )
  if (reply.exceptionDetails)
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
  return reply.result.value
}

export async function loaded(tab: Tab, signal: AbortSignal, loader?: string) {
  const ready = () => (loader ? tab.loaded.has(loader) : !tab.loading)
  if (ready()) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      tab.listeners.delete(changed)
      signal.removeEventListener("abort", abort)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const changed = () => {
      if (tab.closed) {
        cleanup()
        reject(new Error("This browser tab closed. Take a new browser_snapshot."))
        return
      }
      if (!ready()) return
      cleanup()
      resolve()
    }
    tab.listeners.add(changed)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    changed()
  })
}

export async function snapshot(tab: Tab) {
  const header = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String, title: Schema.String }))(
    await evaluate(tab, "({url:location.href,title:document.title})"),
  )
  const frameShape = Schema.Struct({
    frame: Schema.Struct({ id: Schema.String, url: Schema.String }),
    childFrames: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.MutableJson))),
  })
  const frameTree = await command(tab, "Page.getFrameTree")
  const frames: { id: string; url: string }[] = []
  const collect = (value: unknown) => {
    const tree = Schema.decodeUnknownSync(frameShape)(value)
    frames.push(tree.frame)
    tree.childFrames?.forEach(collect)
  }
  collect(frameTree.frameTree)
  tab.frames.forEach((_, id) => {
    if (!frames.some((frame) => frame.id === id)) frames.push({ id, url: "" })
  })
  tab.refs.clear()
  tab.revision++
  const lines: string[] = []
  let count = 0
  for (const frame of frames) {
    const session = tab.frames.get(frame.id) ?? tab.session
    const tree = Schema.decodeUnknownSync(Accessibility)(
      await command(tab, "Accessibility.getFullAXTree", { frameId: frame.id }, session),
    )
    if (frame !== frames[0]) lines.push("Frame: " + shorten(frame.url, 512))
    const rows = new Map(tree.nodes.map((node) => [node.nodeId, node]))
    const walk = (id: string, depth: number) => {
      const node = rows.get(id)
      if (!node) return
      const visible = !node.ignored && !["none", "generic", "InlineTextBox"].includes(node.role?.value ?? "none")
      if (visible) {
        const ref = node.backendDOMNodeId ? "e" + tab.revision + "_" + ++count : undefined
        if (ref) tab.refs.set(ref, { node: node.backendDOMNodeId!, session })
        lines.push(
          "  ".repeat(Math.min(depth, 32)) +
            "- " +
            node.role?.value +
            (node.name?.value ? " " + JSON.stringify(node.name.value) : "") +
            (ref ? " [ref=" + ref + "]" : "") +
            (node.value?.value === undefined ? "" : " value=" + JSON.stringify(node.value.value)) +
            (node.properties ?? [])
              .filter((entry) => ["disabled", "checked", "expanded", "selected", "required"].includes(entry.name))
              .map((entry) => " [" + entry.name + "=" + entry.value.value + "]")
              .join(""),
        )
      }
      node.childIds?.forEach((child) => walk(child, depth + (visible ? 1 : 0)))
    }
    if (tree.nodes[0]) walk(tree.nodes[0].nodeId, 0)
  }
  const title = "Page: " + shorten(header.url, 512) + "\nTitle: " + shorten(header.title, 256) + "\n\n"
  return title + clamp(lines.join("\n"), 51200 - Buffer.byteLength(title))
}

export async function act(tab: Tab, ref: string, text?: string, submit = false) {
  if (!/^e\d+_\d+$/.test(ref) || !tab.refs.has(ref))
    throw new Error("Stale or unknown ref. Take a new browser_snapshot and use a ref from that result.")
  const target = tab.refs.get(ref)!
  const backendNodeId = target.node
  const send = (method: string, params: object = {}) => command(tab, method, params, target.session)
  const resolved = Schema.decodeUnknownSync(Schema.Struct({ object: Schema.Struct({ objectId: Schema.String }) }))(
    await send("DOM.resolveNode", { backendNodeId }),
  )
  const objectId = resolved.object.objectId
  try {
    const ready = Schema.decodeUnknownSync(Remote)(
      await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `async function(){
          const deadline=performance.now()+${tab.actionTimeout};let reason='not ready';
          do {
            if(!this.isConnected)return 'detached';
            this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
            const first=this.getBoundingClientRect();
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            const box=this.getBoundingClientRect(),style=getComputedStyle(this);
            const x=Math.max(0,Math.min(innerWidth-1,box.x+box.width/2)),y=Math.max(0,Math.min(innerHeight-1,box.y+box.height/2));
            let hit=this.ownerDocument.elementFromPoint(x,y);
            while(hit&&hit.shadowRoot&&hit.shadowRoot.elementFromPoint(x,y)!==hit)hit=hit.shadowRoot.elementFromPoint(x,y);
            reason=this.disabled||this.closest('[inert],[aria-disabled="true"]')?'disabled':
              ${text !== undefined}&&this.readOnly?'read-only':
              style.visibility==='hidden'||style.display==='none'||!box.width||!box.height?'not visible':
              ['x','y','width','height'].some(key=>Math.abs(first[key]-box[key])>1)?'moving':
              hit!==this&&!this.contains(hit)?'covered by another element':'';
            if(!reason)return true;
          } while(performance.now()<deadline);
          return reason
        }`,
        awaitPromise: true,
        returnByValue: true,
      }),
    )
    if (ready.result.value !== true)
      throw new Error(
        "This element is " + ready.result.value + ". Take a new browser_snapshot after the page is ready.",
      )
    if (text !== undefined) {
      const focused = Schema.decodeUnknownSync(Remote)(
        await send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration:
            "function(){this.focus();if(this.isContentEditable){const range=document.createRange();range.selectNodeContents(this);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return}if(!['INPUT','TEXTAREA'].includes(this.tagName))throw Error('Choose an editable field');this.select()}",
          returnByValue: true,
        }),
      )
      if (focused.exceptionDetails)
        throw new Error(focused.exceptionDetails.exception?.description ?? focused.exceptionDetails.text)
      await send("Input.insertText", { text })
      if (submit) {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
        })
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        })
      }
      return
    }
    const box = Schema.decodeUnknownSync(
      Schema.Struct({ model: Schema.Struct({ content: Schema.Array(Schema.Number) }) }),
    )(await send("DOM.getBoxModel", { backendNodeId }))
    const x = (box.model.content[0] + box.model.content[2] + box.model.content[4] + box.model.content[6]) / 4
    const y = (box.model.content[1] + box.model.content[3] + box.model.content[5] + box.model.content[7]) / 4
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  } finally {
    await send("Runtime.releaseObject", { objectId }).catch(() => {})
  }
}

export function clamp(text: string, bytes: number) {
  const value = Buffer.from(text)
  if (value.length <= bytes) return text
  const marker = (omitted: number) =>
    "\n\n[snapshot truncated: " + omitted + " more bytes; use browser_evaluate to read a region]"
  const kept = utf8Prefix(value, Math.max(0, bytes - Buffer.byteLength(marker(value.length))))
  return kept + marker(value.length - Buffer.byteLength(kept))
}

function shorten(text: string, bytes: number) {
  const value = Buffer.from(text)
  if (value.length <= bytes) return text
  const marker = (omitted: number) => " …(" + omitted + " more bytes)"
  const kept = utf8Prefix(value, Math.max(0, bytes - Buffer.byteLength(marker(value.length))))
  return kept + marker(value.length - Buffer.byteLength(kept))
}

function utf8Prefix(value: Buffer, bytes: number) {
  let end = Math.min(value.length, bytes)
  while (end > 0 && (value[end] & 0xc0) === 0x80) end--
  return value.subarray(0, end).toString()
}

function abortable<A>(pending: Promise<A>, signal: AbortSignal) {
  return new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
