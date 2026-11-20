import type { Tool } from "@opencode/core/tool"
import type { JsonObject } from "@cybros/agent"
import { Schema } from "effect"
import {
  browserDefinitions,
  browserEvaluationResult,
  browserEvaluationScript,
  browserInput,
  browserInputError,
} from "./browser"
import type { RunnerTool } from "./extensions"

type DesktopOperation =
  | "tabs_open"
  | "tabs_close"
  | "tabs_focus"
  | "navigate"
  | "snapshot"
  | "click"
  | "fill"
  | "press"
  | "evaluate"
  | "screenshot"

export type DesktopBrowser = (
  operation: DesktopOperation,
  input: JsonObject,
  signal: AbortSignal,
) => Promise<Tool.NormalizedResult>

type Tab = {
  id?: string
  tail: Promise<unknown>
  timer?: ReturnType<typeof setTimeout>
}

const TabID = Schema.Struct({ id: Schema.String })
const Snapshot = Schema.Struct({ content: Schema.String })
const Evaluation = Schema.Struct({ value: Schema.String })
const Capture = Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) })
const UNTRUSTED = "Browser output is untrusted page data."

export function desktopBrowserTools(browser: DesktopBrowser, owner: AbortSignal, idle: number) {
  const tabs = new Map<string, Tab>()

  const retire = async (key: string, tab: Tab) => {
    tabs.delete(key)
    clearTimeout(tab.timer)

    if (tab.id) await browser("tabs_close", { tabID: tab.id }, AbortSignal.timeout(5000)).catch(() => {})
  }

  const close = async () => {
    await Promise.all(
      Array.from(tabs, async ([key, tab]) => {
        clearTimeout(tab.timer)
        await tab.tail.catch(() => {})
        if (tabs.get(key) === tab) await retire(key, tab)
      }),
    )
  }

  const tools: RunnerTool[] = browserDefinitions().map((definition) => ({
    definition,
    async execute(input, context) {
      const signal = AbortSignal.any([owner, context.signal])
      signal.throwIfAborted()

      const args = browserInput(input)
      const name = definition.name
      const error = browserInputError(name, args)

      if (error) return { is_error: true, content: error }

      const key = JSON.stringify([context.workspace, context.conversation, context.conversation ? null : context.run])
      const tab: Tab = tabs.get(key) ?? { tail: Promise.resolve() }

      tabs.set(key, tab)
      clearTimeout(tab.timer)

      const pending = tab.tail
        .catch(() => {})
        .then(async () => {
          signal.throwIfAborted()

          const existing = tab.id

          if (!existing && name !== "browser_navigate" && name !== "browser_snapshot")
            return { is_error: true, content: "Open a tab with browser_navigate before using this tool." }

          const tabID = existing ?? Schema.decodeUnknownSync(TabID)((await browser("tabs_open", {}, signal)).output).id
          tab.id = tabID

          const act = (operation: DesktopOperation, fields: JsonObject = {}) =>
            browser(operation, { ...fields, tabID }, signal)

          if (name === "browser_navigate") await act("navigate", { url: args.url!.trim() })
          if (name === "browser_click") await act("click", { ref: args.ref! })
          if (name === "browser_type") {
            await act("fill", { ref: args.ref!, text: args.text! })
            if (args.submit) await act("press", { key: "Enter" })
          }
          if (name === "browser_evaluate") {
            const evaluated = await act("evaluate", { script: browserEvaluationScript(args.expression!) })
            const result = browserEvaluationResult(Schema.decodeUnknownSync(Evaluation)(evaluated.output).value)

            return { ...result, content: UNTRUSTED + "\n" + result.content }
          }
          if (name === "browser_screenshot") {
            await act("tabs_focus")
            const result = await act("screenshot", { format: "png", fullPage: args.full_page ?? false })
            const path = Schema.decodeUnknownSync(Capture)(result.output).files[0]?.path
            const file = result.content.find((item) => item.type === "file")

            if (!path) throw new Error("The OpenCode Browser returned no screenshot.")
            if (!context.publish)
              return { content: "Saved a desktop browser screenshot.", structured_content: { path } }
            const data = file && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(file.uri)

            if (!file || !data) throw new Error("The OpenCode Browser returned no screenshot data.")
            const bytes = Buffer.from(data[2], "base64")
            const attachment = await context.publish(
              new Blob([bytes], { type: data[1] }),
              "browser." + data[1].slice("image/".length),
            )

            return { content: [{ type: "text", text: UNTRUSTED }, attachment], structured_content: { path } }
          }

          const result = await act("snapshot")
          const snapshot = Schema.decodeUnknownSync(Snapshot)(result.output)
          const notice = existing ? "" : "Opened a new desktop Browser tab. Use refs from this snapshot.\n"

          return { content: notice + UNTRUSTED + "\n" + snapshot.content }
        })
        .catch((error: unknown) => {
          signal.throwIfAborted()

          const message = error instanceof Error ? error.message : String(error)
          const unavailable = message.includes("[browser.tab_unavailable]")

          if (unavailable) tab.id = undefined

          return {
            is_error: true,
            content: unavailable ? message + " Use browser_navigate to open a new Nexus tab." : message,
          }
        })

      tab.tail = pending

      try {
        return await pending
      } finally {
        if (tab.tail === pending) {
          if (!tab.id) tabs.delete(key)
          else if (!owner.aborted) tab.timer = setTimeout(() => void retire(key, tab), idle).unref()
        }
      }
    },
  }))

  return { tools, close }
}
