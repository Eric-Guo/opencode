import { expect, test } from "bun:test"
import type { JsonValue } from "@cybros/agent"
import { runCode } from "../src/code"
import { codeBinding } from "../src/code-settings"
import { OperationRefused } from "../src/claim-control"

const binding = { function: { name: "runner_code", parameters: { $id: codeBinding } }, canonical: "code" }
const declarations = [binding, { function: { name: "read" }, route: { kind: "runner", tool_name: "read" } }]
const signal = new AbortController().signal

test("code preserves false, zero and explicit null and buffers selected text", async () => {
  for (const value of [false, 0, null]) {
    expect(
      await runCode(
        'text("visible"); value("old"); return params.value',
        { value },
        [binding],
        async () => null,
        signal,
      ),
    ).toEqual({
      content: [{ type: "text", text: "visible" }],
      structured_content: value,
    })
  }

  expect(await runCode("value(false)", {}, [binding], async () => null, signal)).toEqual({
    content: [],
    structured_content: false,
  })
})

test("code supplies an immediate readonly operation key and preserves tool error envelopes", async () => {
  const result = await runCode(
    `
const work = tools.read({path:"missing"});
text(work.operation_key);
try { work.operation_key = "changed"; } catch {}
return await work;
`,
    {},
    declarations,
    async () => ({ status: "completed", is_error: true, structured_content: null, content: [] }),
    signal,
  )

  expect(result.content[0].text).toBe("op_0")
  expect(result.structured_content).toEqual({
    status: "completed",
    is_error: true,
    structured_content: null,
    content: [],
  })
})

test("code exposes recorded refusals and rejects resources it did not observe", async () => {
  const result = await runCode(
    `
try { await tools.read({path:"missing"}); } catch (error) { return error.refusal; }
`,
    {},
    declarations,
    async () => {
      throw new OperationRefused({ code: "denied", message: "Not allowed" })
    },
    signal,
  )

  expect(result.structured_content).toEqual({ code: "denied", message: "Not allowed" })
  await expect(
    runCode(
      'resource({type:"resource_link",uri:"nexus://uploads/unknown",name:"unknown"})',
      {},
      [binding],
      async () => null,
      signal,
    ),
  ).rejects.toThrow("not observed")
})

test("code forwards observed captures and accepts array step authoring", async () => {
  const capture = { type: "resource_link", uri: "nexus://uploads/image", name: "image.png", mimeType: "image/png" }
  const result = await runCode(
    `
const result = await nexus.steps([{tool:{key:"image",name:"read",input:{path:"image.png"}}}]);
resource(result.content[0]);
`,
    {},
    declarations,
    async (_, request) => {
      expect(request).toEqual({
        kind: "steps",
        input: { steps: [{ tool: { key: "image", name: "read", input: { path: "image.png" } } }] },
      })
      return { status: "completed", content: [capture] }
    },
    signal,
  )

  expect(result).toEqual({ content: [capture] })
})

test("code refuses unjoined operations but ownership receipts permit background work", async () => {
  await expect(
    runCode(
      'tools.read({path:"pending"}); text("not delivered")',
      {},
      declarations,
      () => new Promise(() => {}),
      signal,
    ),
  ).rejects.toThrow("unjoined")

  const result = await runCode(
    `
const work = tools.read({path:"pending"});
await nexus.background({operation_key:work.operation_key,lifetime:"conversation",wake:"auto"});
text("Working");
`,
    {},
    declarations,
    async (_, request) => {
      if (request.kind === "tool") return new Promise(() => {})

      const input = request.input as { operation_key: string }

      return { status: "completed", released_operations: [input.operation_key] }
    },
    signal,
  )

  expect(result).toEqual({ content: [{ type: "text", text: "Working" }] })
})

test("flat declarations, MCP code names and model defaults share one frozen callable catalog", async () => {
  const calls: unknown[] = []
  const result = await runCode(
    `
await tools.code({});
await tools.read({});
await nexus.steps([{parallel:[[{model:{prompt:"Inspect"}}],{model:{prompt:"No tools",tools:[]}}]}]);
await nexus.model({prompt:"Continue"});
return true;
`,
    {},
    [{ name: "read" }, { function: { name: "code" }, route: { kind: "mcp", tool_name: "code" } }, binding],
    async (_, request) => {
      calls.push(request)
      return { status: "completed" }
    },
    signal,
    { tools: ["read", "runner_code"] },
  )

  expect(result.structured_content).toBe(true)
  expect(calls).toEqual([
    { kind: "tool", name: "code", input: {} },
    { kind: "tool", name: "read", input: {} },
    {
      kind: "steps",
      input: {
        steps: [
          {
            parallel: [
              [{ model: { prompt: "Inspect", tools: ["read"] } }],
              { model: { prompt: "No tools", tools: [] } },
            ],
          },
        ],
      },
    },
    { kind: "model", input: { prompt: "Continue", tools: ["read"] } },
  ])
})

test("nested authoring rejects undeclared tools before accepting any operation", async () => {
  const calls: unknown[] = []

  for (const source of [
    'await nexus.model({prompt:"x",tools:["code"]})',
    'await nexus.steps([{parallel:[[{tool:{name:"code",input:{}}}]]}])',
    'await nexus.background({steps:[{model:{prompt:"x",tools:["missing"]}}]})',
    'await nexus.replace({steps:[{tool:{name:"missing",input:{}}}]})',
  ])
    await expect(
      runCode(
        source,
        {},
        declarations,
        async (_, request) => {
          calls.push(request)
          return null
        },
        signal,
      ),
    ).rejects.toThrow("outside this program's callable catalog")

  expect(calls).toEqual([])
})

test("code validates its binding and keeps ambient capabilities and JSON coercion unavailable", async () => {
  await expect(runCode("return 1", {}, [], async () => null, signal)).rejects.toThrow("unsupported_binding")
  await expect(
    runCode(
      "return 1",
      {},
      [{ ...binding, function: { name: "code", parameters: { $id: "old" } } }],
      async () => null,
      signal,
    ),
  ).rejects.toThrow("unsupported_binding")
  expect(
    (
      await runCode(
        "return [typeof Date,typeof Intl,typeof require,typeof bridge,typeof copy]",
        {},
        [binding],
        async () => null,
        signal,
      )
    ).structured_content,
  ).toEqual(Array(5).fill("undefined"))
  for (const source of [
    "Math.random()",
    "return NaN",
    "return new Map()",
    "return [undefined]",
    "return {toJSON:()=>1}",
    "return new Array(2)",
  ])
    await expect(runCode(source, {}, [binding], async () => null, signal)).rejects.toThrow()
})

test("isolated JavaScript preserves native promises and rejects accessors without invoking them", async () => {
  const calls: string[] = []
  const result = await runCode(
    `
class Answer { constructor() { this.value = 42 } }
const work = tools.read({});
const native = work instanceof Promise;
await work;
try { value({get secret() { text("getter ran"); return 1 }}) } catch (error) { text(error.message) }
try { value({[Symbol("secret")]:1}) } catch (error) { text(error.message) }
try { __nexus_codemode("forged", "event", {}) } catch (error) { text(error.message) }
return {native, answer:new Answer().value};
`,
    {},
    declarations,
    async (key) => {
      calls.push(key)
      return null
    },
    signal,
  )
  expect(calls).toEqual(["op_0"])
  expect(result.structured_content).toEqual({ native: true, answer: 42 })
  expect(result.content.map((block) => block.text)).toEqual([
    "JSON properties must contain values",
    "JSON properties require string keys",
    "Host control is unavailable to source",
  ])
  await expect(runCode("return new Promise(()=>{})", {}, [binding], async () => null, signal)).rejects.toThrow(
    "stalled_promise",
  )
})

test("isolated JavaScript interrupts CPU and microtask loops and bounds its own heap", async () => {
  for (const source of [
    "while(true){}",
    "await new Promise(()=>{ const next=()=>Promise.resolve().then(next); next() })",
  ])
    await expect(runCode(source, {}, [binding], async () => null, signal, {}, { computeMs: 20 })).rejects.toThrow(
      "execution_limit",
    )
  await expect(
    runCode(
      "const rows=[]; for(let i=0;i<1000000;i++) rows.push({index:i}); return rows.length",
      {},
      [binding],
      async () => null,
      signal,
      {},
      { heapBytes: 8 * 1024 * 1024 },
    ),
  ).rejects.toThrow(/memory|heap/)
  expect((await runCode("return 42", {}, [binding], async () => null, signal)).structured_content).toBe(42)
})

test("pending request and observation limits reject data before it crosses the next boundary", async () => {
  const calls: string[] = []
  await expect(
    runCode(
      "tools.read({text:params}); tools.read({text:params}); await new Promise(()=>{})",
      "a".repeat(600000),
      declarations,
      async (key) => {
        calls.push(key)
        return null
      },
      signal,
    ),
  ).rejects.toThrow("pending requests")
  expect(calls).toEqual([])
  await expect(
    runCode("return await tools.read({})", {}, declarations, async () => ({ text: "x".repeat(8388608) }), signal),
  ).rejects.toThrow("events exceed")
})

test("cancellation releases a waiting isolated invocation without waiting for its host operation", async () => {
  const controller = new AbortController()
  const accepted = Promise.withResolvers<void>()
  const outcome = Promise.withResolvers<JsonValue>()
  const program = runCode(
    "return await tools.read({})",
    {},
    declarations,
    async () => {
      accepted.resolve()
      return outcome.promise
    },
    controller.signal,
  )
  await accepted.promise
  controller.abort(new Error("canceled code"))
  await expect(program).rejects.toThrow("canceled code")
  outcome.resolve(null)
})
