// Boot-time resolution for direct interactive mode.
//
// These functions run concurrently at startup to gather everything the runtime
// needs before the first frame: keybinds from TUI config, diff display style,
// model variant list with context limits, and session history for the prompt
// history ring. All are async because they read config or hit the SDK, but
// none block each other.
import { TuiConfig } from "../tui/config/tui"
import { reusePendingTask } from "./runtime.shared"
import { resolveSession, sessionHistory } from "./session.shared"
import type { FooterKeybinds, RunDiffStyle, RunInput, RunPrompt } from "./types"
import { pickVariant } from "./variant.shared"

const DEFAULT_KEYBINDS: FooterKeybinds = {
  leader: "ctrl+x",
  variantCycle: "ctrl+t,<leader>t",
  interrupt: "escape",
  historyPrevious: "up",
  historyNext: "down",
  inputSubmit: "return",
  inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
}

const configTask: { current?: ReturnType<typeof TuiConfig.get> } = {}

function loadConfig() {
  return reusePendingTask(configTask, () => TuiConfig.get())
}

export type ModelInfo = {
  variants: string[]
  limits: Record<string, number>
}

export type SessionInfo = {
  first: boolean
  history: RunPrompt[]
  variant: string | undefined
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

// Fetches available variants and context limits for every provider/model pair.
export async function resolveModelInfo(sdk: RunInput["sdk"], model: RunInput["model"]): Promise<ModelInfo> {
  try {
    const response = await sdk.provider.list()
    const providers = response.data?.all ?? []
    const limits: Record<string, number> = {}

    for (const provider of providers) {
      for (const [modelID, info] of Object.entries(provider.models ?? {})) {
        const limit = info?.limit?.context
        if (typeof limit === "number" && limit > 0) {
          limits[modelKey(provider.id, modelID)] = limit
        }
      }
    }

    if (!model) {
      return {
        variants: [],
        limits,
      }
    }

    const provider = providers.find((item) => item.id === model.providerID)
    const modelInfo = provider?.models?.[model.modelID]
    return {
      variants: Object.keys(modelInfo?.variants ?? {}),
      limits,
    }
  } catch {
    return {
      variants: [],
      limits: {},
    }
  }
}

// Fetches session messages to determine if this is the first turn and build prompt history.
export async function resolveSessionInfo(
  sdk: RunInput["sdk"],
  sessionID: string,
  model: RunInput["model"],
): Promise<SessionInfo> {
  try {
    const session = await resolveSession(sdk, sessionID)
    return {
      first: session.first,
      history: sessionHistory(session),
      variant: pickVariant(model, session),
    }
  } catch {
    return {
      first: true,
      history: [],
      variant: undefined,
    }
  }
}

// Reads keybind overrides from TUI config and merges them with defaults.
// Always ensures <leader>t is present in the variant cycle binding.
export async function resolveFooterKeybinds(): Promise<FooterKeybinds> {
  try {
    const config = await loadConfig()
    const configuredLeader = config.keybinds?.leader?.trim() || DEFAULT_KEYBINDS.leader
    const configuredVariantCycle = config.keybinds?.variant_cycle?.trim() || "ctrl+t"
    const configuredInterrupt = config.keybinds?.session_interrupt?.trim() || DEFAULT_KEYBINDS.interrupt
    const configuredHistoryPrevious = config.keybinds?.history_previous?.trim() || DEFAULT_KEYBINDS.historyPrevious
    const configuredHistoryNext = config.keybinds?.history_next?.trim() || DEFAULT_KEYBINDS.historyNext
    const configuredSubmit = config.keybinds?.input_submit?.trim() || DEFAULT_KEYBINDS.inputSubmit
    const configuredNewline = config.keybinds?.input_newline?.trim() || DEFAULT_KEYBINDS.inputNewline

    const variantBindings = configuredVariantCycle
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

    if (!variantBindings.some((binding) => binding.toLowerCase() === "<leader>t")) {
      variantBindings.push("<leader>t")
    }

    return {
      leader: configuredLeader,
      variantCycle: variantBindings.join(","),
      interrupt: configuredInterrupt,
      historyPrevious: configuredHistoryPrevious,
      historyNext: configuredHistoryNext,
      inputSubmit: configuredSubmit,
      inputNewline: configuredNewline,
    }
  } catch {
    return DEFAULT_KEYBINDS
  }
}

export async function resolveDiffStyle(): Promise<RunDiffStyle> {
  try {
    const config = await loadConfig()
    return config.diff_style ?? "auto"
  } catch {
    return "auto"
  }
}
