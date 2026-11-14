import { expect, test } from "bun:test"
import { runCode } from "../src/code"
import { OperationRefused } from "../src/claim-control"

const declarations = [{ function: { name: "read" }, route: { kind: "runner", tool_name: "read" } }]
const signal = new AbortController().signal

test("code preserves false, zero and explicit null and buffers selected text", async () => {
  for (const value of [false, 0, null]) {
    expect(
      await runCode('text("visible"); value("old"); return params.value', { value }, [], async () => null, signal),
    ).toEqual({
      content: [{ type: "text", text: "visible" }],
      structured_content: value,
    })
  }

  expect(await runCode("value(false)", {}, [], async () => null, signal)).toEqual({
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

  expect(result.content[0].text).toStartWith("code_")
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
    runCode('resource({type:"resource_link",uri:"nexus://uploads/unknown"})', {}, [], async () => null, signal),
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
