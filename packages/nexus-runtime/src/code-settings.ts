export const codeBinding = "urn:opencode:nexus:codemode:1"

export const codeInstructions = `Run a program in OpenCode Code Mode's confined JavaScript interpreter.
Use supported JavaScript syntax, no Markdown fences. params holds copied JSON input.
Call tools[name](input) using exact names from the frozen catalog. External effects,
approvals and task results are owned by Nexus. is_error is a result value;
recorded refusals reject. Nexus helper errors expose error.refusal; native tool errors carry a message. Direct filesystem, network and process
access are unavailable. Use declared tools for those operations.
Prefer an explicit return; otherwise the final expression is the structured result.
text(string) and console.log select model-visible text. Returned JSON and value(json)
are UI-only structured output and are never rendered to the model. Print results the
model needs with text(JSON.stringify(result)); keep the result instead of repeating
a successful tool call just to display it. resource(block) forwards a resource_link
observed in this invocation.
Use Promise.all or Promise.allSettled for independent work. Pending attached work is
interrupted when the program ends. The wall-clock budget is ten minutes, including waits.
nexus.model(input), nexus.ask(input), nexus.steps(input), nexus.replace(input),
nexus.cancel(input), nexus.join(input) and nexus.background(input) request Nexus operations.
For an immediate operation handle use:
const work = await nexus.start({kind:"model",input:{prompt:"Inspect the project"}});
const result = await nexus.wait(work);
The handle has operation_key; ordinary tool Promises have no operation_key.
To continue work after returning, await nexus.background({operation_key:work.operation_key,
lifetime:"conversation",wake:"auto"}). Only a successful ownership-transfer receipt
releases the obligation to wait. nexus.steps accepts public step arrays, including
{tool:{name,input,key}}, {model:{prompt,key,after,results}} and {parallel:[...]}.
Nested tools and models may only use the frozen catalog. No source is replayed after loss.`
