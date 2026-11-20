import { Schema } from "effect"
import { definition, type RunnerTool } from "./extensions"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserSession, act, clamp, command, evaluate, loaded, snapshot } from "./browser-session"
import { readEffect } from "./runner"

const Input = Schema.Struct({
  url: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  submit: Schema.optional(Schema.Boolean),
  expression: Schema.optional(Schema.String),
  full_page: Schema.optional(Schema.Boolean),
})
const notice =
  "NOTE: this loop has a new browser tab; earlier refs are invalid. Use the current snapshot before acting.\n\n"
const string = { type: "string" }

export const browserInput = Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })

export function browserInputError(name: string, args: typeof Input.Type) {
  if (name === "browser_navigate" && !args.url?.trim()) return "url is required"
  if ((name === "browser_click" || name === "browser_type") && !args.ref?.trim())
    return "ref is required; use a handle from browser_snapshot."
  if (name === "browser_type" && args.text === undefined) return 'text is required; send "" to clear the field.'
  if (name === "browser_evaluate" && !args.expression?.trim()) return "expression is required."
}

export function browserEvaluationScript(source: string) {
  return `(async()=>{
    const seen=new WeakSet();
    const clean=(value,depth=0)=>{
      if(typeof value==='bigint')return value.toString();
      if(typeof value!=='object'||value===null)return typeof value==='number'&&!Number.isFinite(value)?null:value;
      if(seen.has(value))return '[circular]';
      if(depth>=64)return '[too deep]';
      seen.add(value);
      const output=Array.isArray(value)?value.map(item=>clean(item,depth+1)):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item,depth+1)]));
      seen.delete(value);return output;
    };
    const source=${JSON.stringify(source)};
    const expression=/^\\s*(?:async\\s+)?function\\b/.test(source)?'('+source+')':source;
    const result=await (0,eval)(expression);
    return JSON.stringify(clean(typeof result==='function'?await result():result))??'null';
  })()`
}

export function browserEvaluationResult(value: string) {
  return {
    content: clamp(value, 51200),
    ...(Buffer.byteLength(value) <= 51200
      ? { structured_content: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(value) }
      : {}),
  }
}

export function browserDefinitions() {
  return [
    definition(
      "browser_navigate",
      "Open a URL and return the resulting accessibility snapshot. Use its element refs for later actions. Refs belong to the latest snapshot.",
      { url: string },
      ["url"],
    ),
    definition(
      "browser_snapshot",
      "Read the page accessibility tree. Use the returned refs with browser_click and browser_type; a new-tab notice invalidates earlier refs.",
      {},
      [],
    ),
    definition(
      "browser_click",
      "Click an element by its ref from the latest snapshot and return the resulting page.",
      { ref: string },
      ["ref"],
    ),
    definition(
      "browser_type",
      "Replace a field's contents by snapshot ref. Empty text clears it. Optionally press Enter and return the resulting page.",
      { ref: string, text: string, submit: { type: "boolean" } },
      ["ref", "text"],
    ),
    definition(
      "browser_screenshot",
      "Capture the current viewport or whole page as a PNG attachment.",
      { full_page: { type: "boolean" } },
      [],
    ),
    definition(
      "browser_evaluate",
      "Evaluate JavaScript and return JSON. This can act on the page; prefer the other tools when they express the action.",
      { expression: string },
      ["expression"],
    ),
  ].map((spec) =>
    ["browser_snapshot", "browser_screenshot"].includes(spec.name) ? { ...spec, effect_profile: readEffect } : spec,
  )
}

export function browserTools(
  executable: string,
  signal: AbortSignal,
  session = new BrowserSession(executable, signal),
): RunnerTool[] {
  return browserDefinitions().map((spec) => ({
    definition: spec,
    async execute(input, ctx) {
      const args = browserInput(input)
      const error = browserInputError(spec.name, args)

      if (error) return { is_error: true, content: error }

      const result = session.run(JSON.stringify([ctx.workspace, ctx.run]), ctx.signal, async (tab, active) => {
        const fresh = tab.fresh
        const noticed = (text: string) => (fresh ? notice : "") + text
        try {
          if (spec.name === "browser_navigate") {
            tab.refs.clear()
            const reply = Schema.decodeUnknownSync(
              Schema.Struct({ loaderId: Schema.optional(Schema.String), errorText: Schema.optional(Schema.String) }),
            )(await command(tab, "Page.navigate", { url: args.url?.trim() }))
            if (reply.errorText) throw new Error(reply.errorText)
            await loaded(tab, active, reply.loaderId)
          }
          if (spec.name === "browser_click" || spec.name === "browser_type") {
            await act(tab, args.ref!, spec.name === "browser_type" ? args.text : undefined, args.submit)
            await loaded(tab, active)
          }
          if (spec.name === "browser_screenshot") {
            const layout = args.full_page
              ? Schema.decodeUnknownSync(
                  Schema.Struct({
                    cssContentSize: Schema.Struct({
                      x: Schema.Number,
                      y: Schema.Number,
                      width: Schema.Number,
                      height: Schema.Number,
                    }),
                  }),
                )(await command(tab, "Page.getLayoutMetrics"))
              : undefined
            const image = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.String }))(
              await command(tab, "Page.captureScreenshot", {
                format: "png",
                ...(layout ? { captureBeyondViewport: true, clip: { ...layout.cssContentSize, scale: 1 } } : {}),
              }),
            )
            const bytes = Buffer.from(image.data, "base64")
            const name = "browser-" + createHash("sha256").update(bytes).digest("hex").slice(0, 16) + ".png"
            const directory =
              ctx.artifacts ??
              join(
                tmpdir(),
                "opencode-browser-captures",
                createHash("sha256").update(ctx.directory).digest("hex").slice(0, 16),
              )
            await mkdir(directory, { recursive: true, mode: 0o700 })
            const path = join(directory, name)
            await writeFile(path, bytes)
            const url = await evaluate(tab, "location.href")
            const text = noticed("Saved a screenshot of " + url + " to " + path)
            if (!ctx.publish) return { content: text, structured_content: { path } }
            const resource = await ctx.publish(new Blob([bytes], { type: "image/png" }), name)
            return { content: [{ type: "text", text }, resource], structured_content: { path } }
          }
          if (spec.name === "browser_evaluate") {
            const value = await evaluate(tab, browserEvaluationScript(args.expression!))
            if (typeof value !== "string") throw new Error("Page evaluation returned no JSON.")

            const result = browserEvaluationResult(value)

            return { ...result, content: noticed(result.content) }
          }
          return { content: noticed(await snapshot(tab)) }
        } catch (error) {
          active.throwIfAborted()
          return { is_error: true, content: noticed(error instanceof Error ? error.message : String(error)) }
        }
      })

      return result.catch((error: unknown) => {
        ctx.signal.throwIfAborted()
        signal.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        return {
          is_error: true,
          content:
            error instanceof DOMException && error.name === "TimeoutError"
              ? "Browser call timed out. Take a new browser_snapshot before acting."
              : "Browser driver unavailable: " + message,
        }
      })
    },
  }))
}
