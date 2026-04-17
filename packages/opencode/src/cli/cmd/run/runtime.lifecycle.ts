// Lifecycle management for the split-footer renderer.
//
// Creates the OpenTUI CliRenderer in split-footer mode, resolves the theme
// from the terminal palette, writes the entry splash to scrollback, and
// constructs the RunFooter. Returns a Lifecycle handle whose close() writes
// the exit splash and tears everything down in the right order:
// footer.close → footer.destroy → renderer shutdown.
//
// Also wires SIGINT so Ctrl-c during a turn triggers the two-press exit
// sequence through RunFooter.requestExit().
import { createCliRenderer, type CliRenderer, type ScrollbackWriter } from "@opentui/core"
import * as Locale from "../../../util/locale"
import { entrySplash, exitSplash, splashMeta } from "./splash"
import { resolveRunTheme } from "./theme"
import type {
  FooterApi,
  FooterKeybinds,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunAgent,
  RunDiffStyle,
  RunInput,
  RunPrompt,
  RunResource,
} from "./types"
import { formatModelLabel } from "./variant.shared"

const FOOTER_HEIGHT = 7
const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type SplashState = {
  entry: boolean
  exit: boolean
}

type CycleResult = {
  modelLabel?: string
  status?: string
}

type FooterLabels = {
  agentLabel: string
  modelLabel: string
}

export type LifecycleInput = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  resources: RunResource[]
  sessionID: string
  sessionTitle?: string
  first: boolean
  history: RunPrompt[]
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  keybinds: FooterKeybinds
  diffStyle: RunDiffStyle
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onInterrupt?: () => void
  onSubagentSelect?: (sessionID: string | undefined) => void
}

export type Lifecycle = {
  footer: FooterApi
  close(input: { showExit: boolean; sessionTitle?: string; sessionID?: string }): Promise<void>
}

// Gracefully tears down the renderer. Order matters: switch external output
// back to passthrough before leaving split-footer mode, so pending stdout
// doesn't get captured into the now-dead scrollback pipeline.
function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function splashTitle(title: string | undefined, history: RunPrompt[]): string | undefined {
  if (title && !DEFAULT_TITLE.test(title)) {
    return title
  }

  const next = history.find((item) => item.text.trim().length > 0)
  return next?.text ?? title
}

function splashSession(title: string | undefined, history: RunPrompt[]): boolean {
  if (title && !DEFAULT_TITLE.test(title)) {
    return true
  }

  return !!history.find((item) => item.text.trim().length > 0)
}

function footerLabels(input: Pick<RunInput, "agent" | "model" | "variant">): FooterLabels {
  const agentLabel = Locale.titlecase(input.agent ?? "build")

  if (!input.model) {
    return {
      agentLabel,
      modelLabel: "Model default",
    }
  }

  return {
    agentLabel,
    modelLabel: formatModelLabel(input.model, input.variant),
  }
}

function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

// Boots the split-footer renderer and constructs the RunFooter.
//
// The renderer starts in split-footer mode with captured stdout so that
// scrollback commits and footer repaints happen in the same frame. After
// the entry splash, RunFooter takes over the footer region.
export async function createRuntimeLifecycle(input: LifecycleInput): Promise<Lifecycle> {
  const renderer = await createCliRenderer({
    targetFps: 30,
    maxFps: 60,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    useKittyKeyboard: { events: process.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  })
  let theme = await resolveRunTheme(renderer)
  renderer.setBackgroundColor(theme.background)
  const state: SplashState = {
    entry: false,
    exit: false,
  }
  const showSession = splashSession(input.sessionTitle, input.history)
  const meta = splashMeta({
    title: splashTitle(input.sessionTitle, input.history),
    session_id: input.sessionID,
  })
  queueSplash(
    renderer,
    state,
    "entry",
    entrySplash({
      ...meta,
      theme: theme.entry,
      background: theme.background,
      showSession,
    }),
  )
  await renderer.idle().catch(() => {})

  const { RunFooter } = await import("./footer")

  const labels = footerLabels({
    agent: input.agent,
    model: input.model,
    variant: input.variant,
  })
  const footer = new RunFooter(renderer, {
    directory: input.directory,
    findFiles: input.findFiles,
    agents: input.agents,
    resources: input.resources,
    ...labels,
    first: input.first,
    history: input.history,
    theme,
    keybinds: input.keybinds,
    diffStyle: input.diffStyle,
    onPermissionReply: input.onPermissionReply,
    onQuestionReply: input.onQuestionReply,
    onQuestionReject: input.onQuestionReject,
    onCycleVariant: input.onCycleVariant,
    onInterrupt: input.onInterrupt,
    onSubagentSelect: input.onSubagentSelect,
  })

  const sigint = () => {
    footer.requestExit()
  }
  process.on("SIGINT", sigint)

  let closed = false
  const close = async (next: { showExit: boolean; sessionTitle?: string; sessionID?: string }) => {
    if (closed) {
      return
    }

    closed = true
    process.off("SIGINT", sigint)

    try {
      const show = renderer.isDestroyed ? false : next.showExit
      if (!renderer.isDestroyed && show) {
        const sessionID = next.sessionID ?? input.sessionID
        queueSplash(
          renderer,
          state,
          "exit",
          exitSplash({
            ...splashMeta({
              title: splashTitle(next.sessionTitle ?? input.sessionTitle, input.history),
              session_id: sessionID,
            }),
            theme: theme.entry,
            background: theme.background,
          }),
        )
        await renderer.idle().catch(() => {})
      }
    } finally {
      footer.close()
      footer.destroy()
      shutdown(renderer)
    }
  }

  return {
    footer,
    close,
  }
}
