import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acpTool } from "../src/acp"
import type { RunnerContext } from "../src/extensions"

const context = (directory: string): RunnerContext => ({
  directory,
  workspace: "w",
  conversation: "chat",
  run: "r",
  task: "t",
  signal: AbortSignal.timeout(5000),
})

test("a delegated ACP process receives the project and asks for one-time permission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-nexus-acp-"))
  try {
    const peer = join(dir, "agent.mjs")
    await writeFile(
      peer,
      `
import { createInterface } from "node:readline"
const write = msg => console.log(JSON.stringify({jsonrpc:"2.0", ...msg}))
let prompt
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line)
  if(m.method==="initialize") write({id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}})
  if(m.method==="session/new") write({id:m.id,result:{sessionId:"s"}})
  if(m.method==="session/close") write({id:m.id,result:{}})
  if(m.method==="session/prompt"){
    prompt=m.id
    write({id:"ask",method:"session/request_permission",params:{sessionId:"s",toolCall:{toolCallId:"t",title:"Read a project file"},options:[{optionId:"once",kind:"allow_once",name:"Allow once"}]}})
  }
  if(m.id==="ask"){
    write({method:"session/update",params:{sessionId:"s",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:process.cwd()+" "+m.result.outcome.optionId}}}})
    write({id:prompt,result:{stopReason:"end_turn"}})
  }
}`,
    )
    await using tool = acpTool(JSON.stringify({ peer: [process.execPath, peer] }))
    const result = await tool.execute(
      { agent: "peer", prompt: "inspect" },
      {
        ...context(dir),
        ask: async (_, prompt) => {
          expect(prompt).toContain("Read a project file")
          return "Allow once"
        },
      },
    )
    expect(result.content).toContain(" once")
    await expect(tool.execute({ agent: "unknown", prompt: "x" }, context(dir))).rejects.toThrow("configured")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
