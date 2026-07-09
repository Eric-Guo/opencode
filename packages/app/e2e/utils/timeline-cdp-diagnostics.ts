import type { CDPSession, Page, TestInfo } from "@playwright/test"

export async function startTimelineDiagnostics(page: Page, testInfo: TestInfo) {
  const cdp = await page.context().newCDPSession(page)
  const pauses: unknown[] = []
  const scripts: { url: string; scriptID: string }[] = []
  const breakpoints = new Map<string, string>()
  const setup: Promise<void>[] = []
  let handling = Promise.resolve()

  await cdp.send("Debugger.enable")

  cdp.on("Debugger.scriptParsed", (event) => {
    if (!/tanstack|solid-virtual|virtual-core/i.test(event.url)) return
    scripts.push({ url: event.url, scriptID: event.scriptId })
    setup.push(
      installSourceBreakpoints(cdp, event.scriptId, breakpoints).catch((error) => {
        pauses.push({ type: "breakpoint-install-error", url: event.url, error: String(error) })
      }),
    )
  })

  cdp.on("Debugger.paused", (event) => {
    handling = handling.then(async () => {
      const frame = event.callFrames[0]
      const state = frame
        ? await cdp
            .send("Debugger.evaluateOnCallFrame", {
              callFrameId: frame.callFrameId,
              expression: `(() => {
                const root = [...document.querySelectorAll('.scroll-view__viewport')].find((element) =>
                  element.querySelector('[data-timeline-virtual-content]')
                )
                const indexes = root ? [...root.querySelectorAll('[data-index]')].map((item) => Number(item.getAttribute('data-index'))) : []
                const owner = this && typeof this === 'object' && 'scrollOffset' in this ? this : undefined
                return {
                  now: performance.now(),
                  dom: root ? {
                    scrollTop: root.scrollTop,
                    scrollHeight: root.scrollHeight,
                    clientHeight: root.clientHeight,
                    indexes,
                  } : null,
                  virtualizer: owner ? {
                    scrollOffset: owner.scrollOffset,
                    scrollAdjustments: owner.scrollAdjustments,
                    intendedScrollOffset: owner._intendedScrollOffset,
                    isScrolling: owner.isScrolling,
                    range: owner.range,
                    totalSize: typeof owner.getTotalSize === 'function' ? owner.getTotalSize() : undefined,
                  } : null,
                  active: document.activeElement ? {
                    tag: document.activeElement.tagName,
                    component: document.activeElement.getAttribute('data-component'),
                    slot: document.activeElement.getAttribute('data-slot'),
                    text: document.activeElement.textContent?.trim().slice(0, 80),
                  } : null,
                }
              })()`,
              returnByValue: true,
            })
            .then((result) => result.result.value)
            .catch((error) => ({ error: String(error) }))
        : undefined
      pauses.push({
        type: "pause",
        reason: event.reason,
        data: event.data,
        hitBreakpoints: event.hitBreakpoints?.map((id) => breakpoints.get(id) ?? id),
        state,
        stack: event.callFrames.slice(0, 20).map((item) => ({
          functionName: item.functionName,
          url: item.url,
          line: item.location.lineNumber + 1,
          column: (item.location.columnNumber ?? 0) + 1,
        })),
      })
      await cdp.send("Debugger.resume").catch(() => {})
    })
  })

  await page.addInitScript(() => {
    type TraceWindow = Window & { __timelineDomTrace?: unknown[] }
    const output: unknown[] = []
    ;(window as TraceWindow).__timelineDomTrace = output
    let last = ""
    let observed: HTMLElement | undefined
    const active = () => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement)) return null
      return {
        tag: element.tagName,
        component: element.dataset.component,
        slot: element.dataset.slot,
        text: element.textContent?.trim().slice(0, 80),
      }
    }
    const root = () =>
      [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
        element.querySelector("[data-timeline-virtual-content]"),
      )
    const record = (type: string, detail: Record<string, unknown> = {}) => {
      const element = root()
      const indexes = element
        ? [...element.querySelectorAll<HTMLElement>("[data-index]")].map((item) => Number(item.dataset.index))
        : []
      output.push({
        type,
        at: performance.now(),
        scrollTop: element?.scrollTop,
        scrollHeight: element?.scrollHeight,
        clientHeight: element?.clientHeight,
        indexes,
        active: active(),
        question: !!document.querySelector('[data-component="dock-prompt"][data-kind="question"]'),
        review: !!document.querySelector('#review-panel [data-component="session-review-v2"]'),
        ...detail,
      })
    }
    const watch = () => {
      const element = root()
      if (element && element !== observed) {
        observed = element
        new ResizeObserver(() => record("resize")).observe(element)
      }
      requestAnimationFrame(watch)
    }
    const sample = () => {
      const element = root()
      const indexes = element
        ? [...element.querySelectorAll<HTMLElement>("[data-index]")].map((item) => Number(item.dataset.index))
        : []
      const next = JSON.stringify([
        element?.scrollTop,
        element?.scrollHeight,
        element?.clientHeight,
        indexes[0],
        indexes.at(-1),
        document.activeElement?.getAttribute("data-slot"),
        !!document.querySelector('[data-component="dock-prompt"][data-kind="question"]'),
      ])
      if (next !== last) {
        last = next
        record("frame")
      }
      requestAnimationFrame(sample)
    }
    document.addEventListener("scroll", (event) => record("scroll", { trusted: event.isTrusted }), true)
    document.addEventListener("focusin", (event) => record("focusin", { trusted: event.isTrusted }), true)
    document.addEventListener("focusout", (event) => record("focusout", { trusted: event.isTrusted }), true)
    requestAnimationFrame(watch)
    requestAnimationFrame(sample)
  })

  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing,v8.execute,disabled-by-default-devtools.timeline.stack",
    options: "sampling-frequency=10000",
    transferMode: "ReturnAsStream",
  })

  return {
    async stop() {
      await Promise.allSettled(setup)
      await handling
      const complete = new Promise<string>((resolve, reject) => {
        cdp.once("Tracing.tracingComplete", (event) => {
          if (!event.stream) {
            reject(new Error("CDP tracing completed without a stream"))
            return
          }
          resolve(event.stream)
        })
      })
      await cdp.send("Tracing.end")
      const stream = await complete
      const trace = await readCdpStream(cdp, stream)
      const dom = await page
        .evaluate(() => (window as Window & { __timelineDomTrace?: unknown[] }).__timelineDomTrace ?? [])
        .catch(() => [])
      const { writeFile } = await import("node:fs/promises")
      const tracePath = "C:\\tmp\\opencode\\timeline-devtools-trace.json"
      const debuggerPath = "C:\\tmp\\opencode\\timeline-cdp-debugger.json"
      const domPath = "C:\\tmp\\opencode\\timeline-dom-events.json"
      await Promise.all([
        writeFile(tracePath, trace),
        writeFile(debuggerPath, JSON.stringify({ test: testInfo.title, scripts, pauses }, null, 2)),
        writeFile(domPath, JSON.stringify(dom, null, 2)),
      ])
      await cdp.send("Debugger.disable").catch(() => {})
      await cdp.detach().catch(() => {})
      console.log(`TIMELINE_TRACE ${JSON.stringify({ tracePath, debuggerPath, domPath, pauses: pauses.length })}`)
    },
  }
}

export type TimelineDiagnostics = Awaited<ReturnType<typeof startTimelineDiagnostics>>

async function installSourceBreakpoints(cdp: CDPSession, scriptID: string, labels: Map<string, string>) {
  const targets = [
    ["offset-observer", "this.scrollOffset = offset"],
    ["resize-item", "this.resizeItem = (index, size)"],
    ["apply-scroll-adjustment", "applyScrollAdjustment(delta, behavior)"],
    ["scroll-to-offset", "this._scrollToOffset = (offset"],
    ["scroll-to-end", "this.scrollToEnd ="],
  ] as const
  for (const [label, query] of targets) {
    const matches = await cdp.send("Debugger.searchInContent", { scriptId: scriptID, query })
    for (const match of matches.result) {
      const result = await cdp.send("Debugger.setBreakpoint", {
        location: { scriptId: scriptID, lineNumber: match.lineNumber },
      })
      labels.set(result.breakpointId, label)
    }
  }
}

async function readCdpStream(cdp: CDPSession, handle: string) {
  const chunks: Buffer[] = []
  while (true) {
    const chunk = await cdp.send("IO.read", { handle })
    chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"))
    if (chunk.eof) break
  }
  await cdp.send("IO.close", { handle })
  return Buffer.concat(chunks)
}
