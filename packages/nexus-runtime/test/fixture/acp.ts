import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JsonObject } from "@cybros/agent"
import type { RunnerContext } from "../../src/extensions"

export async function acpFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-acp-client-")))
  const work = join(root, "project")
  const storage = join(root, "private")
  await Promise.all([mkdir(work), mkdir(storage)])
  const events: JsonObject[] = []
  const waits = new Set<{ match: (event: JsonObject) => boolean; resolve: (event: JsonObject) => void }>()
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const gate = (name: string) => {
    const current = gates.get(name) ?? Promise.withResolvers<void>()
    gates.set(name, current)
    return current
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/event") {
        const event = (await request.json()) as JsonObject
        events.push(event)
        waits.forEach((wait) => {
          if (wait.match(event)) {
            waits.delete(wait)
            wait.resolve(event)
          }
        })
        return Response.json({ ok: true })
      }
      await gate(path.slice(1)).promise
      return Response.json({ ok: true })
    },
  })
  const peer = join(root, "peer.mjs")
  await Bun.write(
    peer,
    `
import { agent, ndJsonStream, RequestError } from ${JSON.stringify(import.meta.resolve("@agentclientprotocol/sdk"))};
import { Readable, Writable } from "node:stream";
const url = process.argv[2];
const report = (event, fields={}) => fetch(url+"/event", {method:"POST",body:JSON.stringify({event,pid:process.pid,...fields})});
const gate = name => fetch(url+"/"+name);
const sessions = new Map();
let authenticated = false;
const options = value => [{id:"model",name:"Model",category:"model",type:"select",currentValue:value,options:[{value:"initial",name:"Initial"},{value:"picked",name:"Picked"}]}];
const app = agent({name:"Fixture"})
.onRequest("initialize", async ({params}) => {
  await report("initialize", {capabilities:params.clientCapabilities});
  if(process.env.STARTUP_GATE) await gate("startup-"+process.pid);
  return {protocolVersion:1,agentCapabilities:{},agentInfo:{name:"Fixture",version:"1"},authMethods:process.env.TERMINAL_AUTH ? [{id:"terminal-login",name:"Terminal",type:"terminal"}] : [{id:"login",name:"Login"}]};
})
.onRequest("authenticate", async ({params}) => { authenticated=true;await report("authenticate",{method:params.methodId});return {}; })
.onRequest("session/new", async ({params}) => {
  await report("new",{cwd:params.cwd,mcp:params.mcpServers});
  if(process.env.AUTH_REQUIRED&&!authenticated) throw RequestError.authRequired();
  const id="session-"+(sessions.size+1);
  sessions.set(id,{cwd:params.cwd,model:"initial"});
  return {sessionId:id,configOptions:options("initial")};
})
.onRequest("session/set_config_option", async ({params}) => {sessions.get(params.sessionId).model=params.value;await report("model",{model:params.value});return {configOptions:options(params.value)};})
.onNotification("session/cancel", async ({params}) => {await report("cancel",{session:params.sessionId});})
.onRequest("session/close", async ({params}) => {await report("close",{session:params.sessionId});return {};})
.onRequest("session/prompt", async ctx => {
  const id=ctx.params.sessionId;
  const prompt=ctx.params.prompt.map(part=>part.type==="text"?part.text:"").join("");
  await report("prompt",{prompt,session:id});
  const emit = text => ctx.client.notify("session/update",{sessionId:id,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}});
  if(prompt==="cancelme"||prompt==="deadline"){
    await gate("late-"+process.pid+"-"+id);
    await emit("late output from canceled work");
    return {stopReason:"cancelled"};
  }
  if(prompt==="waiting-permission"){
    const result=await ctx.client.request("session/request_permission",{sessionId:id,toolCall:{toolCallId:"waiting",title:"git status",kind:"execute",rawInput:{command:"git status"}},options:[{optionId:"once",kind:"allow_once",name:"Once"},{optionId:"no",kind:"reject_once",name:"No"}]});
    await report("permission-result",{outcome:result.outcome});
    return {stopReason:"end_turn"};
  }
  if(prompt==="permissions"){
    const requests=[
      {toolCallId:"force",title:"git push",kind:"execute",rawInput:{command:"git push --force"}},
      {toolCallId:"private",title:"edit state",kind:"edit",rawInput:{path:process.env.PROTECTED_PATH,command:42}},
      {toolCallId:"safe",title:"git status",kind:"execute",rawInput:{command:["git","status"]}}
    ];
    const choices=[];
    for(const call of requests){
      await ctx.client.notify("session/update",{sessionId:id,update:{sessionUpdate:"tool_call",...call}});
      const result=await ctx.client.request("session/request_permission",{sessionId:id,toolCall:{toolCallId:call.toolCallId},options:[{optionId:"always",kind:"allow_always",name:"Always"},{optionId:"once",kind:"allow_once",name:"Once"},{optionId:"no",kind:"reject_once",name:"No"}]});
      choices.push(result.outcome.outcome==="selected"?result.outcome.optionId:"cancelled");
    }
    const ask=await ctx.client.request("elicitation/create",{sessionId:id,mode:"form",message:"Which branch?",requestedSchema:{type:"object",properties:{answer:{type:"string"}},required:["answer"]}});
    let code;
    try{await ctx.client.request("fs/read_text_file",{sessionId:id,path:process.env.PROTECTED_PATH});}catch(error){code=error.code;}
    await emit(choices.join(",")+" "+ask.action+" "+code);
    return {stopReason:"end_turn"};
  }
  if(prompt==="secret") await emit("credential: "+process.env.CREDENTIAL_TOKEN);
  else await emit(JSON.stringify({pid:process.pid,session:id,cwd:sessions.get(id).cwd,model:sessions.get(id).model,prompt}));
  return {stopReason:"end_turn"};
});
const connection=app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
await connection.closed;
`,
  )
  return {
    root,
    work,
    storage,
    peer,
    events,
    row: (fields: JsonObject = {}): JsonObject => ({
      command: process.execPath,
      args: [peer, server.url.origin],
      description: "Fixture coding agent",
      ...fields,
    }),
    context: (fields: Partial<RunnerContext> = {}): RunnerContext => ({
      workspace: "workspace",
      conversation: "conversation",
      run: "run",
      task: "task",
      directory: work,
      signal: new AbortController().signal,
      ...fields,
    }),
    wait: (event: string, match: (event: JsonObject) => boolean = () => true) => {
      const found = events.find((row) => row.event === event && match(row))
      if (found) return Promise.resolve(found)
      return new Promise<JsonObject>((resolve) =>
        waits.add({ match: (row) => row.event === event && match(row), resolve }),
      )
    },
    release: (name: string) => gate(name).resolve(),
    async close() {
      gates.forEach((gate) => gate.resolve())
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function eventually(check: () => Promise<boolean>) {
  const signal = AbortSignal.timeout(5000)
  while (!(await check())) {
    signal.throwIfAborted()
    await Bun.sleep(1)
  }
}
