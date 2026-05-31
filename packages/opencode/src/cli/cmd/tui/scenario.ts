import type {
  AssistantMessage,
  GlobalEvent,
  Message,
  Part,
  Session,
  TextPart,
  ToolPart,
  ToolState,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"

export const names = ["tools-mixed", "subagents"] as const
export type Name = (typeof names)[number]

type Transcript = Array<{ info: Message; parts: Part[] }>
type ScenarioEvent = GlobalEvent["payload"]
type Step = { after: number; event: ScenarioEvent }

export function createScenario(input: { name: Name; directory: string; fetch: typeof fetch; speed?: number }) {
  const sessionID = `ses_tui_scenario_${input.name.replaceAll("-", "_")}`
  const created = Date.now()
  const scenario = {
    session: session(sessionID, input.directory, input.name, created),
    transcript: input.name === "subagents" ? subagents(sessionID, created) : toolsMixed(sessionID, created),
  }
  const providers = [
    {
      id: "scenario",
      name: "Scenario",
      source: "custom",
      env: [],
      options: {},
      models: {
        scenario: {
          id: "scenario",
          providerID: "scenario",
          api: { id: "scenario", url: "", npm: "" },
          name: "Preview",
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 1, output: 1 },
          status: "active",
          options: {},
          headers: {},
          release_date: "",
        },
      },
    },
  ]
  const handlers = new Set<(event: GlobalEvent) => void>()
  const timers = new Set<Timer>()
  const speed = input.speed && input.speed > 0 ? input.speed : 1
  let count = 1
  let eventID = 0

  function emit(event: ScenarioEvent) {
    eventID += 1
    event.id = `scenario_event_${eventID}`
    for (const handler of handlers) {
      handler({ directory: "global", payload: event })
    }
  }

  function play(steps: Step[]) {
    for (const step of steps) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        emit(step.event)
      }, step.after / speed)
      timers.add(timer)
    }
  }

  const fetch = Object.assign(
    async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init)
      const pathname = new URL(request.url).pathname
      const base = `/session/${sessionID}`

      if (request.method === "GET" && pathname === base) return json(scenario.session)
      if (request.method === "GET" && pathname === `${base}/message`) return json(scenario.transcript)
      if (request.method === "GET" && (pathname === `${base}/todo` || pathname === `${base}/diff`)) return json([])
      if (request.method === "POST" && pathname === `${base}/message`) {
        const prompt = await promptText(request)
        count += 1
        const turn = interactiveTurn(sessionID, Date.now(), count, prompt)
        play(turn.steps)
        return json({ info: turn.assistant, parts: [] })
      }

      switch (pathname) {
        case "/command":
        case "/experimental/workspace":
        case "/experimental/workspace/status":
        case "/formatter":
        case "/lsp":
          return json([])
        case "/agent":
          return json([
            {
              name: "build",
              description: "Synthetic state preview",
              mode: "primary",
              native: true,
              permission: [],
              model: { providerID: "scenario", modelID: "scenario" },
              options: {},
            },
          ])
        case "/config":
        case "/experimental/resource":
        case "/mcp":
        case "/provider/auth":
        case "/session/status":
          return json({})
        case "/config/providers":
          return json({ providers, default: { scenario: "scenario" } })
        case "/experimental/console":
          return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
        case "/path":
          return json({ home: "", state: "", config: "", worktree: input.directory, directory: input.directory })
        case "/project/current":
          return json({ id: "scenario" })
        case "/provider":
          return json({ all: [], default: { scenario: "scenario" }, connected: ["scenario"] })
        case "/session":
          return json([scenario.session])
        case "/vcs":
          return json({ branch: "scenario" })
      }

      throw new Error(`unexpected scenario request: ${request.method} ${pathname}`)
    },
    { preconnect: input.fetch.preconnect },
  )

  const events: EventSource = {
    subscribe: async (handler) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
        if (handlers.size > 0) return
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
      }
    },
  }

  return { sessionID, fetch, events }
}

function session(sessionID: string, directory: string, name: Name, created: number): Session {
  return {
    id: sessionID,
    slug: `tui-scenario-${name}`,
    projectID: "global",
    directory,
    title: `TUI Scenario: ${name}`,
    version: "scenario",
    time: { created, updated: created },
  }
}

function toolsMixed(sessionID: string, time: number): Transcript {
  return turn(sessionID, time, 1, "Preview mixed tool rendering states.", [
    text(
      sessionID,
      "msg_01_assistant",
      "part_01_intro",
      "Block tools should retain space while consecutive inline tools remain dense.",
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_02_shell",
      "bash",
      completed(
        { command: "git status --short", description: "Show changed files", workdir: "." },
        { output: " M packages/opencode/src/cli/cmd/tui/routes/session/index.tsx\n?? scenario-notes.md" },
        "Show changed files",
      ),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_03_grep",
      "grep",
      completed(
        { pattern: "InlineTool|BlockTool|renderBefore", path: "packages/opencode/src/cli/cmd/tui/routes/session" },
        { matches: 21 },
        "Found matches",
      ),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_04_glob",
      "glob",
      completed({ pattern: "packages/opencode/test/cli/tui/**/*snapshot*" }, { count: 6 }, "Found files"),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_05_read",
      "read",
      completed(
        { filePath: "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx", offset: 1780, limit: 130 },
        {},
        "Read session row renderer",
      ),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_06_edit",
      "edit",
      completed(
        { filePath: "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx" },
        {
          diff: '@@ -1896,1 +1896,2 @@\n- previous?.id.startsWith("text-")\n+ previous?.id.startsWith("text-") ||\n+ previous?.id.startsWith("tool-block-")',
          diagnostics: {},
        },
        "Edit spacing boundary",
      ),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_07_after_block",
      "grep",
      completed(
        { pattern: "tool-block-", path: "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx" },
        { matches: 2 },
        "Verify block marker",
      ),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_08_error",
      "read",
      failed(
        { filePath: "packages/opencode/src/cli/cmd/tui/routes/session/missing.tsx" },
        "Scenario read failed: file does not exist",
      ),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_09_todo",
      "todowrite",
      completed(
        {
          todos: [
            { content: "Inspect spacing states", status: "completed", priority: "high" },
            { content: "Review subagent density", status: "in_progress", priority: "high" },
          ],
        },
        {
          todos: [
            { content: "Inspect spacing states", status: "completed", priority: "high" },
            { content: "Review subagent density", status: "in_progress", priority: "high" },
          ],
        },
        "1 todo",
      ),
    ),
    tool(
      sessionID,
      "msg_01_assistant",
      "part_10_question",
      "question",
      completed(
        {
          questions: [
            {
              header: "Spacing",
              question: "Should adjacent completed subagents retain a blank row?",
              options: [{ label: "Yes", description: "Keep tasks visually distinct" }],
            },
          ],
        },
        { answers: [["Yes"]] },
        "Asked question",
      ),
    ),
    text(
      sessionID,
      "msg_01_assistant",
      "part_11_tip",
      'Type "parallel subagents", "blocks and inline", "errors", or "pending tools" to append live preview turns.',
    ),
  ])
}

function subagents(sessionID: string, time: number): Transcript {
  return turn(sessionID, time, 1, "Preview adjacent and parallel subagent rows.", [
    text(
      sessionID,
      "msg_01_assistant",
      "part_01_intro",
      "These completed task rows are intentionally adjacent so task spacing changes are immediately visible.",
    ),
    task(sessionID, "msg_01_assistant", "part_02_task", "Explore renderer history for task-row regressions", false),
    task(
      sessionID,
      "msg_01_assistant",
      "part_03_task",
      "Compare spacing around long wrapped delegation summaries",
      true,
    ),
    task(
      sessionID,
      "msg_01_assistant",
      "part_04_task",
      "Audit parallel subagent presentation and footer affordances",
      true,
    ),
    text(
      sessionID,
      "msg_01_assistant",
      "part_05_tip",
      'Type "parallel subagents" to append another group, or "blocks and inline" to compare with block boundaries.',
    ),
  ])
}

function interactiveTurn(sessionID: string, time: number, index: number, prompt: string) {
  const ids = {
    user: `msg_${index.toString().padStart(2, "0")}_user`,
    assistant: `msg_${index.toString().padStart(2, "0")}_assistant`,
  }
  const parts = responseParts(sessionID, ids.assistant, prompt)
  const user = userMessage(sessionID, ids.user, time)
  const assistant = assistantMessage(sessionID, ids.assistant, ids.user, time + 1)
  return {
    assistant,
    steps: [
      { after: 0, event: messageUpdated(sessionID, user) },
      { after: 0, event: partUpdated(sessionID, text(sessionID, ids.user, `${ids.user}_text`, prompt)) },
      { after: 80, event: messageUpdated(sessionID, assistant) },
      ...parts.map((part, partIndex) => ({ after: 280 + partIndex * 260, event: partUpdated(sessionID, part) })),
      {
        after: 400 + parts.length * 260,
        event: messageUpdated(sessionID, {
          ...assistant,
          time: { ...assistant.time, completed: Date.now() },
          finish: "stop",
        }),
      },
    ],
  }
}

function responseParts(sessionID: string, messageID: string, prompt: string): Part[] {
  if (/parallel|subagent|task/i.test(prompt)) {
    return [
      text(sessionID, messageID, `${messageID}_01_text`, "Three delegated investigations returned concurrently:"),
      task(sessionID, messageID, `${messageID}_02_task`, "Review layout behavior in the session renderer", false),
      task(sessionID, messageID, `${messageID}_03_task`, "Audit wrapping behavior for long task summaries", true),
      task(sessionID, messageID, `${messageID}_04_task`, "Check task spacing against inline tool density", true),
    ]
  }
  if (/block|diff|edit/i.test(prompt)) {
    return [
      tool(
        sessionID,
        messageID,
        `${messageID}_01_shell`,
        "bash",
        completed(
          { command: "git diff --stat", description: "Inspect diff" },
          { output: " session/index.tsx | 4 ++--" },
          "Inspect diff",
        ),
      ),
      tool(
        sessionID,
        messageID,
        `${messageID}_02_read`,
        "read",
        completed({ filePath: "src/session/index.tsx" }, {}, "Read source"),
      ),
      tool(
        sessionID,
        messageID,
        `${messageID}_03_grep`,
        "grep",
        completed({ pattern: "InlineTool" }, { matches: 4 }, "Search source"),
      ),
    ]
  }
  if (/error|fail|denied/i.test(prompt)) {
    return [
      tool(sessionID, messageID, `${messageID}_01_error`, "read", failed({ filePath: "missing.ts" }, "File not found")),
      tool(
        sessionID,
        messageID,
        `${messageID}_02_read`,
        "read",
        completed({ filePath: "recovered.ts" }, {}, "Read fallback"),
      ),
    ]
  }
  if (/pending|running|spinner/i.test(prompt)) {
    return [
      tool(
        sessionID,
        messageID,
        `${messageID}_01_read`,
        "read",
        running({ filePath: "src/session/index.tsx" }, "Reading source"),
      ),
      tool(
        sessionID,
        messageID,
        `${messageID}_02_task`,
        "task",
        running({ description: "Inspect running agent", subagent_type: "explore" }, "Delegating"),
      ),
    ]
  }
  return [
    tool(
      sessionID,
      messageID,
      `${messageID}_01_grep`,
      "grep",
      completed({ pattern: prompt }, { matches: 12 }, "Search preview"),
    ),
    tool(
      sessionID,
      messageID,
      `${messageID}_02_read`,
      "read",
      completed({ filePath: "src/cli/cmd/tui/routes/session/index.tsx" }, {}, "Read preview"),
    ),
  ]
}

function turn(sessionID: string, time: number, index: number, prompt: string, parts: Part[]): Transcript {
  const userID = `msg_${index.toString().padStart(2, "0")}_user`
  const assistantID = `msg_${index.toString().padStart(2, "0")}_assistant`
  return [
    {
      info: userMessage(sessionID, userID, time),
      parts: [text(sessionID, userID, `${userID}_text`, prompt)],
    },
    {
      info: assistantMessage(sessionID, assistantID, userID, time + 1, true),
      parts,
    },
  ]
}

function userMessage(sessionID: string, id: string, time: number): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: time },
    agent: "build",
    model: { providerID: "scenario", modelID: "scenario" },
  }
}

function assistantMessage(
  sessionID: string,
  id: string,
  parentID: string,
  time: number,
  complete = false,
): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: time, ...(complete ? { completed: time + 500 } : {}) },
    parentID,
    modelID: "scenario",
    providerID: "scenario",
    mode: "build",
    agent: "build",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(complete ? { finish: "stop" } : {}),
  }
}

function text(sessionID: string, messageID: string, id: string, value: string): TextPart {
  return { id, sessionID, messageID, type: "text", text: value }
}

function task(sessionID: string, messageID: string, id: string, description: string, background: boolean) {
  return tool(
    sessionID,
    messageID,
    id,
    "task",
    completed({ description, subagent_type: "explore" }, { background }, description),
  )
}

function tool(sessionID: string, messageID: string, id: string, name: string, state: ToolState): ToolPart {
  return { id, sessionID, messageID, type: "tool", callID: `call_${id}`, tool: name, state }
}

function completed(input: Record<string, unknown>, metadata: Record<string, unknown>, title: string): ToolState {
  return {
    status: "completed",
    input,
    output: title,
    title,
    metadata,
    time: { start: Date.now(), end: Date.now() + 1 },
  }
}

function running(input: Record<string, unknown>, title: string): ToolState {
  return { status: "running", input, title, metadata: {}, time: { start: Date.now() } }
}

function failed(input: Record<string, unknown>, error: string): ToolState {
  return { status: "error", input, error, time: { start: Date.now(), end: Date.now() + 1 } }
}

function messageUpdated(sessionID: string, info: Message): ScenarioEvent {
  return { id: "scenario", type: "message.updated", properties: { sessionID, info } }
}

function partUpdated(sessionID: string, part: Part): ScenarioEvent {
  return { id: "scenario", type: "message.part.updated", properties: { sessionID, part, time: Date.now() } }
}

async function promptText(request: Request) {
  const body: unknown = await request.json()
  if (!body || typeof body !== "object" || !("parts" in body) || !Array.isArray(body.parts)) return "Preview tools"
  return body.parts
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part)) return []
      return typeof part.text === "string" ? [part.text] : []
    })
    .join("\n")
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
}
