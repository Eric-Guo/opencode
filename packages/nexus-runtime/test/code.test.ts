import { expect, test } from "bun:test"
import type { JsonValue, JsonObject } from "@cybros/agent"
import { runCode } from "../src/code"
import { codeBinding } from "../src/code-settings"
import { OperationRefused } from "../src/claim-control"

const binding = { function: { name: "runner_code", parameters: { $id: codeBinding } }, canonical: "code" }
const declarations = [binding, { function: { name: "read" }, route: { kind: "runner", tool_name: "read" } }]
const signal = new AbortController().signal

test("code preserves false, zero and explicit null and buffers selected text", async () => {
  for (const value of [false, 0, null]) {
    expect(
      await run('text("visible"); value("old"); return params.value', { value }, [binding], async () => null, signal),
    ).toEqual({
      content: [{ type: "text", text: "visible" }],
      structured_content: value,
    })
  }

  expect(await run("value(false)", {}, [binding], async () => null, signal)).toEqual({
    content: [],
    structured_content: false,
  })
})

test("code returns explicit operation handles and preserves tool error envelopes", async () => {
  const result = await run(
    `
const work = await nexus.start({kind:"tool",name:"read",input:{path:"missing"}});
text(work.operation_key);
return await nexus.wait(work);
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
  const result = await run(
    `
try { await nexus.wait(await nexus.start({kind:"tool",name:"read",input:{path:"missing"}})); } catch (error) { return error.refusal; }
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
    run(
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
  const result = await run(
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

  expect(result).toEqual({ content: [capture], structured_content: null })
})

test("code cancels unfinished attached operations and preserves confirmed background ownership", async () => {
  const requests: JsonObject[] = []
  const result = await run(
    'await nexus.start({kind:"tool",name:"read",input:{}}); text("Done")',
    {},
    declarations,
    async (_, request) => {
      requests.push(request)
      if (request.kind === "tool") return new Promise(() => {})
      return null
    },
    signal,
  )
  expect(result.content).toEqual([{ type: "text", text: "Done" }])
  expect(requests.at(-1)).toEqual({ kind: "cancel", input: { operation_key: "op_0" } })
  requests.length = 0
  const background = await run(
    `const work = await nexus.start({kind:"tool",name:"read",input:{}});
await nexus.background({operation_key:work.operation_key,lifetime:"conversation",wake:"auto"});
text("Working");`,
    {},
    declarations,
    async (_, request) => {
      requests.push(request)
      if (request.kind === "tool") return new Promise(() => {})
      const input = request.input as { operation_key: string }
      return { status: "completed", released_operations: [input.operation_key] }
    },
    signal,
  )
  expect(background.content).toEqual([{ type: "text", text: "Working" }])
  expect(requests.map((request) => request.kind)).toEqual(["tool", "background"])
})

test("flat declarations, MCP code names and model defaults share one frozen callable catalog", async () => {
  const calls: unknown[] = []
  const result = await run(
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
      run(
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

test("native Code Mode uses its own language, results and copied bindings", async () => {
  await expect(run("return 1", {}, [], async () => null, signal)).rejects.toThrow("unsupported_binding")
  await expect(
    run(
      "return 1",
      {},
      [
        {
          ...binding,
          function: {
            name: "code",
            parameters: {
              $id: "urn:cybros:rho:codemode:javascript:1",
            },
          },
        },
      ],
      async () => null,
      signal,
    ),
  ).rejects.toThrow("unsupported_binding")
  expect((await run("1 + 2", {}, [binding], async () => null, signal)).structured_content).toBe(3)
  const params = { x: 1 }
  expect(
    (await run("params.x = 2; return params.x", params, [binding], async () => null, signal)).structured_content,
  ).toBe(2)
  expect(params).toEqual({ x: 1 })
  await expect(run("class Answer {}", {}, [binding], async () => null, signal)).rejects.toThrow("UnsupportedSyntax")
  expect((await run('console.log("visible"); value(false)', {}, [binding], async () => null, signal)).content).toEqual([
    { type: "text", text: "visible" },
  ])
})

test("native Code Mode interrupts CPU and microtask loops with a wall-clock budget", async () => {
  for (const source of [
    "while(true){}",
    "await new Promise(()=>{ const next=()=>Promise.resolve().then(next); next() })",
  ])
    await expect(run(source, {}, [binding], async () => null, signal, {}, { timeoutMs: 20 })).rejects.toThrow(
      /TimeoutExceeded|promise that can never settle/,
    )
  expect((await run("return 42", {}, [binding], async () => null, signal)).structured_content).toBe(42)
})

test("cancellation releases a waiting isolated invocation without waiting for its host operation", async () => {
  const controller = new AbortController()
  const accepted = Promise.withResolvers<void>()
  const outcome = Promise.withResolvers<JsonValue>()
  const program = run(
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

function run(
  source: string,
  params: JsonValue,
  declarations: JsonValue[],
  operation: (key: string, request: JsonObject) => Promise<JsonValue>,
  signal: AbortSignal,
  defaults: JsonObject = {},
  limits = {},
) {
  return runCode(
    source,
    params,
    declarations,
    async (key, request) => ({
      event: { type: "operation", key, request, receipt: {}, position: 1, refusal: null, outcome: null },
      outcome: Promise.resolve().then(() => operation(key, request)),
    }),
    signal,
    defaults,
    limits,
  )
}

test("host transport failures escape source catch and actual acceptance mismatches stop the VM", async () => {
  await expect(
    run(
      'try { await tools.read({}); } catch { return "hidden" }',
      {},
      declarations,
      async () => {
        throw new Error("transport lost")
      },
      signal,
    ),
  ).rejects.toThrow("transport lost")
  await expect(
    runCode(
      'return await tools.read({path:"original"})',
      {},
      declarations,
      async (key) => ({
        event: {
          type: "operation",
          key,
          request: { kind: "tool", name: "read", input: { path: "changed" } },
          receipt: {},
          position: 1,
          refusal: null,
          outcome: null,
        },
        outcome: Promise.resolve(null),
      }),
      signal,
    ),
  ).rejects.toThrow("Accepted operation differs")
})

test("Code Mode observes recorded completion order even while a later acceptance is pending", async () => {
  const first = Promise.withResolvers<JsonValue>()
  const second = Promise.withResolvers<JsonValue>()
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const won = Promise.withResolvers<void>()
  const program = runCode(
    `
const first = tools.read({index:1});
const second = tools.read({index:2});
const third = tools.read({index:3});
const winner = await Promise.race([first, second]);
text(String(winner));
await tools.read({winner});
await Promise.all([first, second, third]);
`,
    {},
    declarations,
    async (key, request) => {
      if (
        request.input &&
        typeof request.input === "object" &&
        !Array.isArray(request.input) &&
        request.input.winner === "second"
      )
        won.resolve()
      if (
        request.input &&
        typeof request.input === "object" &&
        !Array.isArray(request.input) &&
        request.input.index === 3
      ) {
        ready.resolve()
        await release.promise
      }
      return {
        event: { type: "operation", key, request, receipt: {}, position: 1, refusal: null, outcome: null },
        outcome: key === "op_0" ? first.promise : key === "op_1" ? second.promise : Promise.resolve(null),
      }
    },
    signal,
  )
  await ready.promise
  second.resolve("second")
  await won.promise
  first.resolve("first")
  await Promise.resolve()
  release.resolve()
  expect((await program).content).toEqual([{ type: "text", text: "second" }])
})

test("native tools expose the frozen schema and reject invalid arguments before Nexus submission", async () => {
  const calls: JsonObject[] = []
  const catalog = [
    binding,
    {
      function: {
        name: "read",
        description: "Read the frozen document",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", pattern: "^[a-z]+$" },
            mode: { type: "string" },
            token: { type: "string" },
          },
          if: { properties: { mode: { const: "token" } }, required: ["mode"] },
          then: { required: ["token"] },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
  ]
  for (const input of ["{}", '{path:"INVALID"}', '{path:"read",extra:true}', '{path:"read",mode:"token"}'])
    await expect(
      run(
        "await tools.read(" + input + ")",
        {},
        catalog,
        async (_, request) => {
          calls.push(request)
          return null
        },
        signal,
      ),
    ).rejects.toThrow("InvalidToolInput")
  expect(calls).toEqual([])
  const found = await run('return search({query:"read"})', {}, catalog, async () => null, signal)
  expect(JSON.stringify(found.structured_content)).toContain("Read the frozen document")
})
