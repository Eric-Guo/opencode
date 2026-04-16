// Demo mode for testing direct interactive mode without a real SDK.
//
// Enabled with `--demo`. Intercepts prompt submissions and generates synthetic
// SDK events that feed through the real reducer and footer pipeline. This
// lets you test scrollback formatting, permission UI, question UI, and tool
// snapshots without making actual model calls.
//
// Slash commands:
//   /permission [kind] → triggers a permission request variant
//   /question [kind]   → triggers a question request variant
//   /fmt <kind>   → emits a specific tool/text type (text, reasoning, bash,
//                   write, edit, patch, task, todo, question, error, mix)
//
// Demo mode also handles permission and question replies locally, completing
// or failing the synthetic tool parts as appropriate.
import path from "path"
import type { Event } from "@opencode-ai/sdk/v2"
import { createSessionData, reduceSessionData, type SessionData } from "./session-data"
import { writeSessionOutput } from "./stream"
import type { FooterApi, PermissionReply, QuestionReject, QuestionReply, RunDemo, RunPrompt } from "./types"

const KINDS = ["text", "reasoning", "bash", "write", "edit", "patch", "task", "todo", "question", "error", "mix"]
const PERMISSIONS = ["edit", "bash", "read", "task", "external", "doom"] as const
const QUESTIONS = ["multi", "single", "checklist", "custom"] as const

type PermissionKind = (typeof PERMISSIONS)[number]
type QuestionKind = (typeof QUESTIONS)[number]

const SAMPLE_TEXT = [
  "# Demo markdown",
  "",
  "This is sample assistant output for direct mode formatting checks.",
  "It includes **bold**, _italic_, and `inline code`.",
  "",
  "- bullet: short line",
  "- bullet: long line that should wrap cleanly in narrow terminals while keeping list indentation readable",
  "- bullet: [link text](https://example.com)",
  "",
  "1. ordered item",
  "2. second ordered item",
  "",
  "> quote line for spacing and style checks",
  "",
  "```ts",
  "const sample = { ok: true, count: 42 }",
  "```",
  "",
  "| key   | value |",
  "| ----- | ----- |",
  "| alpha | one   |",
  "| beta  | two   |",
].join("\n")

type Ref = {
  msg: string
  part: string
  call: string
  tool: string
  input: Record<string, unknown>
  start: number
}

type Ask = {
  ref: Ref
}

type Perm = {
  ref: Ref
  done: {
    title: string
    output: string
    metadata?: Record<string, unknown>
  }
}

type Permit = {
  ref: Ref
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  always: string[]
  done: Perm["done"]
}

type State = {
  id: string
  thinking: boolean
  data: SessionData
  footer: FooterApi
  limits: () => Record<string, number>
  msg: number
  part: number
  call: number
  perm: number
  ask: number
  perms: Map<string, Perm>
  asks: Map<string, Ask>
}

type Input = {
  mode: RunDemo
  text?: string
  sessionID: string
  thinking: boolean
  limits: () => Record<string, number>
  footer: FooterApi
}

function note(footer: FooterApi, text: string): void {
  footer.append({
    kind: "system",
    text,
    phase: "start",
    source: "system",
  })
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }

    if (signal.aborted) {
      resolve()
      return
    }

    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done)
      resolve()
    }, ms)

    signal.addEventListener("abort", done, { once: true })
  })
}

function split(text: string): string[] {
  if (text.length <= 48) {
    return [text]
  }

  const size = Math.ceil(text.length / 3)
  return [text.slice(0, size), text.slice(size, size * 2), text.slice(size * 2)]
}

function take(state: State, key: "msg" | "part" | "call" | "perm" | "ask", prefix: string): string {
  state[key] += 1
  return `demo_${prefix}_${state[key]}`
}

function feed(state: State, event: Event): void {
  const out = reduceSessionData({
    data: state.data,
    event,
    sessionID: state.id,
    thinking: state.thinking,
    limits: state.limits(),
  })
  state.data = out.data
  writeSessionOutput(
    {
      footer: state.footer,
    },
    out,
  )
}

function open(state: State): string {
  const id = take(state, "msg", "msg")
  feed(state, {
    type: "message.updated",
    properties: {
      sessionID: state.id,
      info: {
        id,
        sessionID: state.id,
        role: "assistant",
        time: {
          created: Date.now(),
        },
        parentID: `user_${id}`,
        modelID: "demo",
        providerID: "demo",
        mode: "demo",
        agent: "demo",
        path: {
          cwd: process.cwd(),
          root: process.cwd(),
        },
        cost: 0.001,
        tokens: {
          input: 120,
          output: 320,
          reasoning: 80,
          cache: {
            read: 0,
            write: 0,
          },
        },
      },
    },
  } as Event)
  return id
}

async function emitText(state: State, body: string, signal?: AbortSignal): Promise<void> {
  const msg = open(state)
  const part = take(state, "part", "part")
  const start = Date.now()

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "text",
        text: "",
        time: {
          start,
        },
      },
    },
  } as Event)

  let next = ""
  for (const item of split(body)) {
    if (signal?.aborted) {
      return
    }

    next += item
    feed(state, {
      type: "message.part.delta",
      properties: {
        sessionID: state.id,
        messageID: msg,
        partID: part,
        field: "text",
        delta: item,
      },
    } as Event)
    await wait(45, signal)
  }

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "text",
        text: next,
        time: {
          start,
          end: Date.now(),
        },
      },
    },
  } as Event)
}

async function emitReasoning(state: State, body: string, signal?: AbortSignal): Promise<void> {
  const msg = open(state)
  const part = take(state, "part", "part")
  const start = Date.now()

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "reasoning",
        text: "",
        time: {
          start,
        },
      },
    },
  } as Event)

  let next = ""
  for (const item of split(body)) {
    if (signal?.aborted) {
      return
    }

    next += item
    feed(state, {
      type: "message.part.delta",
      properties: {
        sessionID: state.id,
        messageID: msg,
        partID: part,
        field: "text",
        delta: item,
      },
    } as Event)
    await wait(45, signal)
  }

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "reasoning",
        text: next,
        time: {
          start,
          end: Date.now(),
        },
      },
    },
  } as Event)
}

function make(state: State, tool: string, input: Record<string, unknown>): Ref {
  return {
    msg: open(state),
    part: take(state, "part", "part"),
    call: take(state, "call", "call"),
    tool,
    input,
    start: Date.now(),
  }
}

function startTool(state: State, ref: Ref, metadata: Record<string, unknown> = {}): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "running",
          input: ref.input,
          metadata,
          time: {
            start: ref.start,
          },
        },
      },
    },
  } as Event)
}

function askPermission(state: State, item: Permit): void {
  startTool(state, item.ref)

  const id = take(state, "perm", "perm")
  state.perms.set(id, {
    ref: item.ref,
    done: item.done,
  })

  feed(state, {
    type: "permission.asked",
    properties: {
      id,
      sessionID: state.id,
      permission: item.permission,
      patterns: item.patterns,
      metadata: item.metadata ?? {},
      always: item.always,
      tool: {
        messageID: item.ref.msg,
        callID: item.ref.call,
      },
    },
  } as Event)
}

function doneTool(
  state: State,
  ref: Ref,
  output: {
    title: string
    output: string
    metadata?: Record<string, unknown>
  },
): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "completed",
          input: ref.input,
          output: output.output,
          title: output.title,
          metadata: output.metadata ?? {},
          time: {
            start: ref.start,
            end: Date.now(),
          },
        },
      },
    },
  } as Event)
}

function failTool(state: State, ref: Ref, error: string): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "error",
          input: ref.input,
          error,
          metadata: {},
          time: {
            start: ref.start,
            end: Date.now(),
          },
        },
      },
    },
  } as Event)
}

function emitError(state: State, text: string): void {
  feed(state, {
    type: "session.error",
    properties: {
      sessionID: state.id,
      error: {
        name: "DemoError",
        message: text,
      },
    },
  } as unknown as Event)
}

async function emitBash(state: State, signal?: AbortSignal): Promise<void> {
  const ref = make(state, "bash", {
    command: "git status",
    workdir: process.cwd(),
    description: "Show git status",
  })
  startTool(state, ref)
  await wait(70, signal)
  doneTool(state, ref, {
    title: "git status",
    output: `${process.cwd()}\ngit status\nOn branch demo\nnothing to commit, working tree clean\n`,
    metadata: {
      exitCode: 0,
    },
  })
}

function emitWrite(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "write", {
    filePath: file,
    content: "export const demo = 42\n",
  })
  doneTool(state, ref, {
    title: "write",
    output: "",
    metadata: {},
  })
}

function emitEdit(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "edit", {
    filePath: file,
  })
  doneTool(state, ref, {
    title: "edit",
    output: "",
    metadata: {
      diff: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
    },
  })
}

function emitPatch(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "apply_patch", {
    patchText: "*** Begin Patch\n*** End Patch",
  })
  doneTool(state, ref, {
    title: "apply_patch",
    output: "",
    metadata: {
      files: [
        {
          type: "update",
          filePath: file,
          relativePath: "src/demo-format.ts",
          diff: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
          deletions: 1,
        },
        {
          type: "add",
          filePath: path.join(process.cwd(), "README-demo.md"),
          relativePath: "README-demo.md",
          diff: "@@ -0,0 +1,4 @@\n+# Demo\n+This is a generated preview file.\n",
          deletions: 0,
        },
      ],
    },
  })
}

function emitTask(state: State): void {
  const ref = make(state, "task", {
    description: "Scan run/* for reducer touchpoints",
    subagent_type: "explore",
  })
  doneTool(state, ref, {
    title: "Reducer touchpoints found",
    output: "",
    metadata: {
      toolcalls: 4,
      sessionId: "sub_demo_1",
    },
  })
}

function emitTodo(state: State): void {
  const ref = make(state, "todowrite", {
    todos: [
      {
        content: "Trigger permission UI",
        status: "completed",
      },
      {
        content: "Trigger question UI",
        status: "in_progress",
      },
      {
        content: "Tune tool formatting",
        status: "pending",
      },
    ],
  })
  doneTool(state, ref, {
    title: "todowrite",
    output: "",
    metadata: {},
  })
}

function emitQuestionTool(state: State): void {
  const ref = make(state, "question", {
    questions: [
      {
        header: "Style",
        question: "Which output style do you want to inspect?",
        options: [
          { label: "Diff", description: "Show diff block" },
          { label: "Code", description: "Show code block" },
        ],
        multiple: false,
      },
      {
        header: "Extras",
        question: "Pick extra rows",
        options: [
          { label: "Usage", description: "Add usage row" },
          { label: "Duration", description: "Add duration row" },
        ],
        multiple: true,
        custom: true,
      },
    ],
  })
  doneTool(state, ref, {
    title: "question",
    output: "",
    metadata: {
      answers: [["Diff"], ["Usage", "custom-note"]],
    },
  })
}

function emitPermission(state: State, kind: PermissionKind = "edit"): void {
  const root = process.cwd()
  const file = path.join(root, "src", "demo-format.ts")

  if (kind === "bash") {
    const command = "git status --short"
    const ref = make(state, "bash", {
      command,
      workdir: root,
      description: "Inspect worktree changes",
    })
    askPermission(state, {
      ref,
      permission: "bash",
      patterns: [command],
      always: ["*"],
      done: {
        title: "git status --short",
        output: `${root}\ngit status --short\n M src/demo-format.ts\n?? src/demo-permission.ts\n`,
        metadata: {
          exitCode: 0,
        },
      },
    })
    return
  }

  if (kind === "read") {
    const target = path.join(root, "package.json")
    const ref = make(state, "read", {
      filePath: target,
      offset: 1,
      limit: 80,
    })
    askPermission(state, {
      ref,
      permission: "read",
      patterns: [target],
      always: [target],
      done: {
        title: "read",
        output: ["1: {", '2:   "name": "opencode",', '3:   "private": true', "4: }"].join("\n"),
        metadata: {},
      },
    })
    return
  }

  if (kind === "task") {
    const ref = make(state, "task", {
      description: "Inspect footer spacing across direct-mode prompts",
      subagent_type: "explore",
    })
    askPermission(state, {
      ref,
      permission: "task",
      patterns: ["explore"],
      always: ["*"],
      done: {
        title: "Footer spacing checked",
        output: "",
        metadata: {
          toolcalls: 3,
          sessionId: "sub_demo_perm_1",
        },
      },
    })
    return
  }

  if (kind === "external") {
    const dir = path.join(path.dirname(root), "demo-shared")
    const target = path.join(dir, "README.md")
    const ref = make(state, "read", {
      filePath: target,
      offset: 1,
      limit: 40,
    })
    askPermission(state, {
      ref,
      permission: "external_directory",
      patterns: [`${dir}/**`],
      metadata: {
        parentDir: dir,
        filepath: target,
      },
      always: [`${dir}/**`],
      done: {
        title: "read",
        output: `1: # External demo\n2: Shared preview file\nPath: ${target}`,
        metadata: {},
      },
    })
    return
  }

  if (kind === "doom") {
    const ref = make(state, "task", {
      description: "Retry the formatter after repeated failures",
      subagent_type: "general",
    })
    askPermission(state, {
      ref,
      permission: "doom_loop",
      patterns: ["*"],
      always: ["*"],
      done: {
        title: "Retry allowed",
        output: "Continuing after repeated failures.\n",
        metadata: {},
      },
    })
    return
  }

  const diff = "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n"
  const ref = make(state, "edit", {
    filePath: file,
    filepath: file,
    diff,
  })
  askPermission(state, {
    ref,
    permission: "edit",
    patterns: [file],
    always: [file],
    done: {
      title: "edit",
      output: "",
      metadata: {
        diff,
      },
    },
  })
}

function emitQuestion(state: State, kind: QuestionKind = "multi"): void {
  const questions =
    kind === "single"
      ? [
          {
            header: "Mode",
            question: "Which footer should be the reference for spacing checks?",
            options: [
              { label: "Permission", description: "Inspect the permission footer" },
              { label: "Question", description: "Keep this question footer open" },
              { label: "Prompt", description: "Return to the normal composer" },
            ],
            multiple: false,
            custom: false,
          },
        ]
      : kind === "checklist"
        ? [
            {
              header: "Checks",
              question: "Select the direct-mode cases you want to inspect next",
              options: [
                { label: "Diff", description: "Show an edit diff in the footer" },
                { label: "Task", description: "Show a structured task summary" },
                { label: "Todo", description: "Show a todo snapshot" },
                { label: "Error", description: "Show an error transcript row" },
              ],
              multiple: true,
              custom: false,
            },
          ]
        : kind === "custom"
          ? [
              {
                header: "Reply",
                question: "What custom answer should appear in the footer preview?",
                options: [
                  { label: "Short note", description: "Keep the answer to one line" },
                  { label: "Wrapped note", description: "Use a longer answer to test wrapping" },
                ],
                multiple: false,
                custom: true,
              },
            ]
          : [
              {
                header: "Layout",
                question: "Which footer view should stay active while testing?",
                options: [
                  { label: "Prompt", description: "Return to prompt" },
                  { label: "Question", description: "Keep question open" },
                ],
                multiple: false,
              },
              {
                header: "Rows",
                question: "Pick formatting previews",
                options: [
                  { label: "Diff", description: "Emit edit diff" },
                  { label: "Task", description: "Emit task card" },
                  { label: "Todo", description: "Emit todo card" },
                ],
                multiple: true,
                custom: true,
              },
            ]

  const ref = make(state, "question", { questions })
  startTool(state, ref)

  const id = take(state, "ask", "ask")
  state.asks.set(id, { ref })

  feed(state, {
    type: "question.asked",
    properties: {
      id,
      sessionID: state.id,
      questions,
      tool: {
        messageID: ref.msg,
        callID: ref.call,
      },
    },
  } as Event)
}

async function emitFmt(state: State, kind: string, body: string, signal?: AbortSignal): Promise<boolean> {
  if (kind === "text") {
    await emitText(state, body || SAMPLE_TEXT, signal)
    return true
  }

  if (kind === "reasoning") {
    await emitReasoning(state, body || "Planning next steps [REDACTED] while preserving reducer ordering.", signal)
    return true
  }

  if (kind === "bash") {
    await emitBash(state, signal)
    return true
  }

  if (kind === "write") {
    emitWrite(state)
    return true
  }

  if (kind === "edit") {
    emitEdit(state)
    return true
  }

  if (kind === "patch") {
    emitPatch(state)
    return true
  }

  if (kind === "task") {
    emitTask(state)
    return true
  }

  if (kind === "todo") {
    emitTodo(state)
    return true
  }

  if (kind === "question") {
    emitQuestionTool(state)
    return true
  }

  if (kind === "error") {
    emitError(state, body || "demo error event")
    return true
  }

  if (kind === "mix") {
    await emitText(state, "Demo run: assistant text block for wrap testing.", signal)
    await wait(50, signal)
    await emitReasoning(state, "Thinking through formatter edge cases [REDACTED].", signal)
    await wait(50, signal)
    await emitBash(state, signal)
    emitWrite(state)
    emitEdit(state)
    emitPatch(state)
    emitTask(state)
    emitTodo(state)
    emitQuestionTool(state)
    emitError(state, "demo mixed scenario error")
    return true
  }

  return false
}

function intro(state: State): void {
  note(
    state.footer,
    [
      "Demo slash commands enabled for interactive mode.",
      `- /permission [kind] (${PERMISSIONS.join(", ")})`,
      `- /question [kind] (${QUESTIONS.join(", ")})`,
      `- /fmt <kind> (${KINDS.join(", ")})`,
      "Examples:",
      "- /permission bash",
      "- /question custom",
      "- /fmt mix",
      "- /fmt text your custom text",
    ].join("\n"),
  )
}

export function createRunDemo(input: Input) {
  const state: State = {
    id: input.sessionID,
    thinking: input.thinking,
    data: createSessionData(),
    footer: input.footer,
    limits: input.limits,
    msg: 0,
    part: 0,
    call: 0,
    perm: 0,
    ask: 0,
    perms: new Map(),
    asks: new Map(),
  }

  const start = async (): Promise<void> => {
    intro(state)
    if (input.mode === "on") {
      return
    }

    if (input.mode === "permission") {
      emitPermission(state, "edit")
      return
    }

    if (input.mode === "question") {
      emitQuestion(state, "multi")
      return
    }

    if (input.mode === "mix") {
      await emitFmt(state, "mix", "")
      return
    }

    if (input.mode === "text") {
      await emitFmt(state, "text", input.text ?? SAMPLE_TEXT)
    }
  }

  const prompt = async (line: RunPrompt, signal?: AbortSignal): Promise<boolean> => {
    const text = line.text.trim()
    const list = text.split(/\s+/)
    const cmd = list[0] || ""

    if (cmd === "/help") {
      intro(state)
      return true
    }

    if (cmd === "/permission") {
      const kind = (list[1] || "edit").toLowerCase() as PermissionKind
      if (!PERMISSIONS.includes(kind)) {
        note(state.footer, `Pick a permission kind: ${PERMISSIONS.join(", ")}`)
        return true
      }

      emitPermission(state, kind)
      return true
    }

    if (cmd === "/question") {
      const kind = (list[1] || "multi").toLowerCase() as QuestionKind
      if (!QUESTIONS.includes(kind)) {
        note(state.footer, `Pick a question kind: ${QUESTIONS.join(", ")}`)
        return true
      }

      emitQuestion(state, kind)
      return true
    }

    if (cmd === "/fmt") {
      const kind = (list[1] || "").toLowerCase()
      const body = list.slice(2).join(" ")
      if (!kind) {
        note(state.footer, `Pick a kind: ${KINDS.join(", ")}`)
        return true
      }

      const ok = await emitFmt(state, kind, body, signal)
      if (ok) {
        return true
      }

      note(state.footer, `Unknown kind \"${kind}\". Use: ${KINDS.join(", ")}`)
      return true
    }

    return false
  }

  const permission = (input: PermissionReply): boolean => {
    const item = state.perms.get(input.requestID)
    if (!item) {
      return false
    }

    state.perms.delete(input.requestID)
    feed(state, {
      type: "permission.replied",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
        reply: input.reply,
      },
    } as Event)

    if (input.reply === "reject") {
      failTool(state, item.ref, input.message || "permission rejected")
      return true
    }

    doneTool(state, item.ref, item.done)
    return true
  }

  const questionReply = (input: QuestionReply): boolean => {
    const ask = state.asks.get(input.requestID)
    if (!ask) {
      return false
    }

    state.asks.delete(input.requestID)
    feed(state, {
      type: "question.replied",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
        answers: input.answers,
      },
    } as Event)
    doneTool(state, ask.ref, {
      title: "question",
      output: "",
      metadata: {
        answers: input.answers,
      },
    })
    return true
  }

  const questionReject = (input: QuestionReject): boolean => {
    const ask = state.asks.get(input.requestID)
    if (!ask) {
      return false
    }

    state.asks.delete(input.requestID)
    feed(state, {
      type: "question.rejected",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
      },
    } as Event)
    failTool(state, ask.ref, "question rejected")
    return true
  }

  return {
    start,
    prompt,
    permission,
    questionReply,
    questionReject,
  }
}
