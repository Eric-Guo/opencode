import { expect, test as base, type Page, type TestInfo } from "@playwright/test"

const marker = "__OPENCODE_E2E_ERROR_TOAST__"

type ErrorToastObservation = {
  component: "legacy" | "v2"
  title: string
  description: string
  text: string
  url: string
  timestamp: number
}

type ErrorToastExpectation = {
  pattern: string | RegExp
  seen: boolean
}

export type ErrorToastControl = {
  expect: (pattern: string | RegExp) => void
  allow: (pattern?: string | RegExp) => void
}

type ErrorToastState = ErrorToastControl & {
  allowed: boolean
  allowedPatterns: (string | RegExp)[]
  expected: ErrorToastExpectation[]
}

type Fixtures = {
  errorToasts: ErrorToastControl
}

export const test = base.extend<Fixtures>({
  errorToasts: async ({}, use) => use(createErrorToastState()),
  page: async ({ page, errorToasts }, use, testInfo) => {
    const guard = await guardPage(page, testInfo, errorToasts as ErrorToastState)
    try {
      await use(page)
    } finally {
      await guard.finish()
    }
  },
})

export { expect }
export type { Browser, CDPSession, Locator, Page, Route, TestInfo } from "@playwright/test"

export async function guardPage(page: Page, testInfo: TestInfo, control = createErrorToastState()) {
  const observations: ErrorToastObservation[] = []
  const unexpected: ErrorToastObservation[] = []
  let closing = false
  const onConsole = (message: { text: () => string }) => {
    const text = message.text()
    if (!text.startsWith(marker)) return

    const observation = JSON.parse(text.slice(marker.length)) as ErrorToastObservation
    observations.push(observation)
    console.error(`E2E_ERROR_TOAST ${JSON.stringify(observation)}`)

    const expected = control.expected.find((item) => !item.seen && matches(item.pattern, observation.text))
    if (expected) {
      expected.seen = true
      return
    }
    if (control.allowed || control.allowedPatterns.some((pattern) => matches(pattern, observation.text))) return

    unexpected.push(observation)
    if (closing) return
    closing = true
    void page.close().catch(() => {})
  }

  page.on("console", onConsole)
  await page.addInitScript(installErrorToastObserver, marker)
  await page.evaluate(installErrorToastObserver, marker)

  return {
    async finish() {
      if (!page.isClosed()) {
        await page
          .evaluate(() => {
            ;(window as Window & { __flushErrorToastObserver?: () => void }).__flushErrorToastObserver?.()
          })
          .catch(() => {})
      }
      page.off("console", onConsole)
      if (observations.length > 0) {
        await testInfo.attach("error-toasts", {
          body: JSON.stringify(observations, null, 2),
          contentType: "application/json",
        })
      }

      const missing = control.expected.filter((item) => !item.seen)
      if (unexpected.length === 0 && missing.length === 0) return

      const messages = [
        ...unexpected.map((item) => `Unexpected error toast: ${item.text}`),
        ...missing.map((item) => `Expected error toast was not shown: ${String(item.pattern)}`),
      ]
      throw new Error(messages.join("\n"))
    },
  }
}

function createErrorToastState(): ErrorToastState {
  const state: ErrorToastState = {
    allowed: false,
    allowedPatterns: [],
    expected: [],
    expect(pattern) {
      state.expected.push({ pattern, seen: false })
    },
    allow(pattern) {
      if (pattern !== undefined) {
        state.allowedPatterns.push(pattern)
        return
      }
      state.allowed = true
    },
  }
  return state
}

function matches(pattern: string | RegExp, value: string) {
  if (typeof pattern === "string") return value.includes(pattern)
  pattern.lastIndex = 0
  return pattern.test(value)
}

function installErrorToastObserver(marker: string) {
  const owner = window as Window & {
    __errorToastObserverInstalled?: boolean
    __flushErrorToastObserver?: () => void
  }
  if (owner.__errorToastObserverInstalled) return
  owner.__errorToastObserverInstalled = true

  const selector = '[data-component="toast"][data-variant="error"], [data-component="toast-v2"][data-variant="error"]'
  const seen = new WeakSet<Element>()
  const pending = new Set<Node>()
  let scheduled = false
  const inspect = (node: Node) => {
    const element = node instanceof HTMLElement ? node : node.parentElement
    if (!element) return
    const candidates = [
      ...(element.matches(selector) ? [element] : []),
      ...element.querySelectorAll<HTMLElement>(selector),
      ...(element.closest<HTMLElement>(selector) ? [element.closest<HTMLElement>(selector)!] : []),
    ]
    candidates.forEach((toast) => {
      if (seen.has(toast)) return
      const text = toast.textContent?.replace(/\s+/g, " ").trim()
      if (!text) return
      seen.add(toast)
      const component = toast.dataset.component === "toast-v2" ? "v2" : "legacy"
      const title = toast.querySelector<HTMLElement>(`[data-slot="toast${component === "v2" ? "-v2" : ""}-title"]`)
      const description = toast.querySelector<HTMLElement>(
        `[data-slot="toast${component === "v2" ? "-v2" : ""}-description"]`,
      )
      console.debug(
        marker +
          JSON.stringify({
            component,
            title: title?.textContent?.trim() ?? "",
            description: description?.textContent?.trim() ?? "",
            text,
            url: location.href,
            timestamp: Date.now(),
          }),
      )
    })
  }
  const scan = () => {
    scheduled = false
    pending.forEach(inspect)
    pending.clear()
  }
  const schedule = (node: Node) => {
    pending.add(node)
    if (scheduled) return
    scheduled = true
    queueMicrotask(scan)
  }
  const start = () => {
    const root = document.documentElement
    if (!root) return
    new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type !== "childList") schedule(record.target)
        record.addedNodes.forEach(schedule)
      })
    }).observe(root, {
      attributes: true,
      attributeFilter: ["data-variant"],
      childList: true,
      characterData: true,
      subtree: true,
    })
    schedule(root)
  }
  owner.__flushErrorToastObserver = () => {
    const root = document.documentElement
    if (root) pending.add(root)
    scan()
  }

  if (document.documentElement) start()
  else document.addEventListener("readystatechange", start, { once: true })
}
