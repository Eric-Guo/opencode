// Top-level orchestrator for `run --interactive`.
//
// Wires the boot sequence, lifecycle (renderer + footer), stream transport,
// and prompt queue together into a single session loop. Two entry points:
//
//   runInteractiveMode     -- used when an SDK client already exists (attach mode)
//   runInteractiveLocalMode -- used for local in-process mode (no server)
//
// Both delegate to runInteractiveRuntime, which:
//   1. resolves keybinds, diff style, model info, and session history,
//   2. creates the split-footer lifecycle (renderer + RunFooter),
//   3. starts the stream transport (SDK event subscription),
//   4. runs the prompt queue until the footer closes.
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { createRunDemo } from "./demo"
import { resolveDiffStyle, resolveFooterKeybinds, resolveModelInfo, resolveSessionInfo } from "./runtime.boot"
import { createRuntimeLifecycle } from "./runtime.lifecycle"
import { trace } from "./trace"
import { cycleVariant, formatModelLabel, resolveSavedVariant, resolveVariant, saveVariant } from "./variant.shared"
import type { RunInput } from "./types"

/** @internal Exported for testing */
export { pickVariant, resolveVariant } from "./variant.shared"

/** @internal Exported for testing */
export { runPromptQueue } from "./runtime.queue"

type BootContext = Pick<RunInput, "sdk" | "directory" | "sessionID" | "sessionTitle" | "agent" | "model" | "variant">

type RunRuntimeInput = {
  boot: () => Promise<BootContext>
  afterPaint?: (ctx: BootContext) => Promise<void> | void
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
  demo?: RunInput["demo"]
  demoText?: RunInput["demoText"]
}

type RunLocalInput = {
  directory: string
  fetch: typeof globalThis.fetch
  resolveAgent: () => Promise<string | undefined>
  session: (sdk: RunInput["sdk"]) => Promise<{ id: string; title?: string } | undefined>
  share: (sdk: RunInput["sdk"], sessionID: string) => Promise<void>
  agent: RunInput["agent"]
  model: RunInput["model"]
  variant: RunInput["variant"]
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
  demo?: RunInput["demo"]
  demoText?: RunInput["demoText"]
}

// Core runtime loop. Boot resolves the SDK context, then we set up the
// lifecycle (renderer + footer), wire the stream transport for SDK events,
// and feed prompts through the queue until the user exits.
//
// Files only attach on the first prompt turn -- after that, includeFiles
// flips to false so subsequent turns don't re-send attachments.
async function runInteractiveRuntime(input: RunRuntimeInput): Promise<void> {
  const log = trace()
  const keybindTask = resolveFooterKeybinds()
  const diffTask = resolveDiffStyle()
  const ctx = await input.boot()
  const modelTask = resolveModelInfo(ctx.sdk, ctx.model)
  const sessionTask = resolveSessionInfo(ctx.sdk, ctx.sessionID, ctx.model)
  const savedTask = resolveSavedVariant(ctx.model)
  const agentsTask = ctx.sdk.app
    .agents({ directory: ctx.directory })
    .then((x) => x.data ?? [])
    .catch(() => [])
  const resourcesTask = ctx.sdk.experimental.resource
    .list({ directory: ctx.directory })
    .then((x) => Object.values(x.data ?? {}))
    .catch(() => [])
  let variants: string[] = []
  let limits: Record<string, number> = {}
  let aborting = false
  let shown = false
  let demo: ReturnType<typeof createRunDemo> | undefined
  const [keybinds, diffStyle, session, savedVariant, agents, resources] = await Promise.all([
    keybindTask,
    diffTask,
    sessionTask,
    savedTask,
    agentsTask,
    resourcesTask,
  ])
  shown = !session.first
  let activeVariant = resolveVariant(ctx.variant, session.variant, savedVariant, variants)

  const shell = await createRuntimeLifecycle({
    directory: ctx.directory,
    findFiles: (query) =>
      ctx.sdk.find
        .files({ query, directory: ctx.directory })
        .then((x) => x.data ?? [])
        .catch(() => []),
    agents,
    resources,
    sessionID: ctx.sessionID,
    sessionTitle: ctx.sessionTitle,
    first: session.first,
    history: session.history,
    agent: ctx.agent,
    model: ctx.model,
    variant: activeVariant,
    keybinds,
    diffStyle,
    onPermissionReply: async (next) => {
      if (demo?.permission(next)) {
        return
      }

      log?.write("send.permission.reply", next)
      await ctx.sdk.permission.reply(next)
    },
    onQuestionReply: async (next) => {
      if (demo?.questionReply(next)) {
        return
      }

      await ctx.sdk.question.reply(next)
    },
    onQuestionReject: async (next) => {
      if (demo?.questionReject(next)) {
        return
      }

      await ctx.sdk.question.reject(next)
    },
    onCycleVariant: () => {
      if (!ctx.model || variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      activeVariant = cycleVariant(activeVariant, variants)
      saveVariant(ctx.model, activeVariant)
      return {
        status: activeVariant ? `variant ${activeVariant}` : "variant default",
        modelLabel: formatModelLabel(ctx.model, activeVariant),
      }
    },
    onInterrupt: () => {
      if (aborting) {
        return
      }

      aborting = true
      void ctx.sdk.session
        .abort({
          sessionID: ctx.sessionID,
        })
        .catch(() => {})
        .finally(() => {
          aborting = false
        })
    },
  })
  const footer = shell.footer

  if (input.demo) {
    demo = createRunDemo({
      mode: input.demo,
      text: input.demoText,
      footer,
      sessionID: ctx.sessionID,
      thinking: input.thinking,
      limits: () => limits,
    })
  }

  if (input.afterPaint) {
    void Promise.resolve(input.afterPaint(ctx)).catch(() => {})
  }

  void modelTask.then((info) => {
    variants = info.variants
    limits = info.limits

    const next = resolveVariant(ctx.variant, session.variant, savedVariant, variants)
    if (next === activeVariant) {
      return
    }

    activeVariant = next
    if (!ctx.model || footer.isClosed) {
      return
    }

    footer.event({
      type: "model",
      model: formatModelLabel(ctx.model, activeVariant),
    })
  })

  try {
    const mod = await import("./stream.transport")
    let includeFiles = true
    const stream = await mod.createSessionTransport({
      sdk: ctx.sdk,
      sessionID: ctx.sessionID,
      thinking: input.thinking,
      limits: () => limits,
      footer,
      trace: log,
    })

    try {
      if (demo) {
        await demo.start()
      }

      const queue = await import("./runtime.queue")
      await queue.runPromptQueue({
        footer,
        initialInput: input.initialInput,
        trace: log,
        onPrompt: () => {
          shown = true
        },
        run: async (prompt, signal) => {
          if (demo && (await demo.prompt(prompt, signal))) {
            return
          }

          try {
            await stream.runPromptTurn({
              agent: ctx.agent,
              model: ctx.model,
              variant: activeVariant,
              prompt,
              files: input.files,
              includeFiles,
              signal,
            })
            includeFiles = false
          } catch (error) {
            if (signal.aborted || footer.isClosed) {
              return
            }
            footer.append({ kind: "error", text: mod.formatUnknownError(error), phase: "start", source: "system" })
          }
        },
      })
    } finally {
      await stream.close()
    }
  } finally {
    const title = shown
      ? await ctx.sdk.session
          .get({
            sessionID: ctx.sessionID,
          })
          .then((x) => x.data?.title)
          .catch(() => undefined)
      : undefined

    await shell.close({
      showExit: shown,
      sessionTitle: title,
    })
  }
}

// Local in-process mode. Creates an SDK client backed by a direct fetch to
// the in-process server, so no external HTTP server is needed.
export async function runInteractiveLocalMode(input: RunLocalInput): Promise<void> {
  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: input.fetch,
    directory: input.directory,
  })

  return runInteractiveRuntime({
    files: input.files,
    initialInput: input.initialInput,
    thinking: input.thinking,
    demo: input.demo,
    demoText: input.demoText,
    afterPaint: (ctx) => input.share(ctx.sdk, ctx.sessionID),
    boot: async () => {
      const agent = await input.resolveAgent()
      const session = await input.session(sdk)
      if (!session?.id) {
        throw new Error("Session not found")
      }

      return {
        sdk,
        directory: input.directory,
        sessionID: session.id,
        sessionTitle: session.title,
        agent,
        model: input.model,
        variant: input.variant,
      }
    },
  })
}

// Attach mode. Uses the caller-provided SDK client directly.
export async function runInteractiveMode(input: RunInput): Promise<void> {
  return runInteractiveRuntime({
    files: input.files,
    initialInput: input.initialInput,
    thinking: input.thinking,
    demo: input.demo,
    demoText: input.demoText,
    boot: async () => ({
      sdk: input.sdk,
      directory: input.directory,
      sessionID: input.sessionID,
      sessionTitle: input.sessionTitle,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
    }),
  })
}
