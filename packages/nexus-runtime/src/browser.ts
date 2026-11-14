import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"
import { definition, type RunnerTool } from "./extensions"
import { webSite } from "./web"
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

export function browserTools(
  executable: string,
  signal: AbortSignal,
  session = new BrowserSession(executable, signal),
): RunnerTool[] {
  const specs = [
    definition(
      "browser_navigate",
      "Open an HTTP(S) URL and return the resulting accessibility snapshot. Start with its [ref=eN_N] handles; never guess selectors. Refs belong to the latest snapshot.",
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
  ]
  return specs.map((spec) => ({
    definition: ["browser_snapshot", "browser_screenshot"].includes(spec.name)
      ? { ...spec, effect_profile: readEffect }
      : spec,
    async execute(input, ctx) {
      const args = Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(input)
      if (!ctx.conversation) throw new Error("A conversation must own the browser.")
      if (spec.name === "browser_navigate") webSite(args.url)
      if (["browser_click", "browser_type"].includes(spec.name) && !args.ref?.trim())
        throw new Error("ref is required; use a handle from browser_snapshot.")
      if (spec.name === "browser_type" && args.text === undefined)
        throw new Error('text is required; send "" to clear the field.')
      if (spec.name === "browser_evaluate" && !args.expression?.trim()) throw new Error("expression is required.")
      return session.run(JSON.stringify([ctx.workspace, ctx.run]), ctx.signal, async (tab, active) => {
        const fresh = tab.fresh
        const noticed = (text: string) => (fresh ? notice : "") + text
        try {
          if (spec.name === "browser_navigate") {
            tab.refs.clear()
            const reply = Schema.decodeUnknownSync(
              Schema.Struct({ loaderId: Schema.optional(Schema.String), errorText: Schema.optional(Schema.String) }),
            )(await command(tab, "Page.navigate", { url: args.url }))
            if (reply.errorText) throw new Error(reply.errorText)
            await loaded(tab, active, reply.loaderId)
          }
          if (spec.name === "browser_click" || spec.name === "browser_type") {
            await act(tab, args.ref!, spec.name === "browser_type" ? args.text : undefined, args.submit)
            await loaded(tab, active)
          }
          if (spec.name === "browser_screenshot") {
            if (!ctx.publish) throw new Error("Screenshot publication requires an active Nexus claim.")
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
            const resource = await ctx.publish(
              new Blob([Buffer.from(image.data, "base64")], { type: "image/png" }),
              "screenshot.png",
            )
            return { content: [...(fresh ? [{ type: "text", text: notice } as JsonObject] : []), resource] }
          }
          if (spec.name === "browser_evaluate") {
            const value = await evaluate(
              tab,
              `(async()=>{
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
              return JSON.stringify(clean(await (0,eval)(${JSON.stringify(args.expression)})))??'null';
            })()`,
            )
            if (typeof value !== "string") throw new Error("Page evaluation returned no JSON.")
            return {
              content: noticed(clamp(value, 32768)),
              ...(Buffer.byteLength(value) <= 32768
                ? { structured_content: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(value) }
                : {}),
            }
          }
          return { content: noticed(await snapshot(tab)) }
        } catch (error) {
          active.throwIfAborted()
          return { is_error: true, content: noticed(error instanceof Error ? error.message : String(error)) }
        }
      })
    },
  }))
}
