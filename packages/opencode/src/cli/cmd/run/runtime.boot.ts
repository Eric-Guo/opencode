// Boot-time resolution for direct interactive mode.
//
// These functions run concurrently at startup to gather everything the runtime
// needs before the first frame: keybinds from TUI config, diff display style,
// model variant list with context limits, and session history for the prompt
// history ring. All are async because they read config or hit the SDK, but
// none block each other.
import { Context, Effect, Layer } from "effect"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { makeRuntime } from "@/effect/run-service"
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

export type ModelInfo = {
  variants: string[]
  limits: Record<string, number>
}

export type SessionInfo = {
  first: boolean
  history: RunPrompt[]
  variant: string | undefined
}

type Config = Awaited<ReturnType<typeof TuiConfig.get>>
type BootService = {
  readonly resolveModelInfo: (sdk: RunInput["sdk"], model: RunInput["model"]) => Effect.Effect<ModelInfo>
  readonly resolveSessionInfo: (
    sdk: RunInput["sdk"],
    sessionID: string,
    model: RunInput["model"],
  ) => Effect.Effect<SessionInfo>
  readonly resolveFooterKeybinds: () => Effect.Effect<FooterKeybinds>
  readonly resolveDiffStyle: () => Effect.Effect<RunDiffStyle>
}

const configTask: { current?: Promise<Config> } = {}

class Service extends Context.Service<Service, BootService>()("@opencode/RunBoot") {}

function loadConfig() {
  return reusePendingTask(configTask, () => TuiConfig.get())
}

function emptyModelInfo(): ModelInfo {
  return {
    variants: [],
    limits: {},
  }
}

function emptySessionInfo(): SessionInfo {
  return {
    first: true,
    history: [],
    variant: undefined,
  }
}

function footerKeybinds(config: Config | undefined): FooterKeybinds {
  const leader = config?.keybinds?.leader?.trim() || DEFAULT_KEYBINDS.leader
  const cycle = config?.keybinds?.variant_cycle?.trim() || "ctrl+t"
  const interrupt = config?.keybinds?.session_interrupt?.trim() || DEFAULT_KEYBINDS.interrupt
  const previous = config?.keybinds?.history_previous?.trim() || DEFAULT_KEYBINDS.historyPrevious
  const next = config?.keybinds?.history_next?.trim() || DEFAULT_KEYBINDS.historyNext
  const submit = config?.keybinds?.input_submit?.trim() || DEFAULT_KEYBINDS.inputSubmit
  const newline = config?.keybinds?.input_newline?.trim() || DEFAULT_KEYBINDS.inputNewline

  const bindings = cycle
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  if (!bindings.some((binding) => binding.toLowerCase() === "<leader>t")) {
    bindings.push("<leader>t")
  }

  return {
    leader,
    variantCycle: bindings.join(","),
    interrupt,
    historyPrevious: previous,
    historyNext: next,
    inputSubmit: submit,
    inputNewline: newline,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = Effect.fn("RunBoot.config")(() =>
      Effect.promise(loadConfig).pipe(
        Effect.orElseSucceed(() => undefined),
      ),
    )

    const resolveModelInfo = Effect.fn("RunBoot.resolveModelInfo")(function* (sdk: RunInput["sdk"], model: RunInput["model"]) {
      const providers = yield* Effect.promise(() => sdk.provider.list()).pipe(
        Effect.map((item) => item.data?.all ?? []),
        Effect.orElseSucceed(() => []),
      )
      const limits = Object.fromEntries(
        providers.flatMap((provider) =>
          Object.entries(provider.models ?? {}).flatMap(([modelID, info]) => {
            const limit = info?.limit?.context
            if (typeof limit !== "number" || limit <= 0) {
              return []
            }

            return [[`${provider.id}/${modelID}`, limit] as const]
          }),
        ),
      )

      if (!model) {
        return {
          variants: [],
          limits,
        }
      }

      const info = providers.find((item) => item.id === model.providerID)?.models?.[model.modelID]
      return {
        variants: Object.keys(info?.variants ?? {}),
        limits,
      }
    })

    const resolveSessionInfo = Effect.fn("RunBoot.resolveSessionInfo")(function* (
      sdk: RunInput["sdk"],
      sessionID: string,
      model: RunInput["model"],
    ) {
      const session = yield* Effect.promise(() => resolveSession(sdk, sessionID)).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (!session) {
        return emptySessionInfo()
      }

      return {
        first: session.first,
        history: sessionHistory(session),
        variant: pickVariant(model, session),
      }
    })

    const resolveFooterKeybinds = Effect.fn("RunBoot.resolveFooterKeybinds")(function* () {
      return footerKeybinds(yield* config())
    })

    const resolveDiffStyle = Effect.fn("RunBoot.resolveDiffStyle")(function* () {
      return (yield* config())?.diff_style ?? "auto"
    })

    return Service.of({
      resolveModelInfo,
      resolveSessionInfo,
      resolveFooterKeybinds,
      resolveDiffStyle,
    })
  }),
)

const runtime = makeRuntime(Service, layer)

// Fetches available variants and context limits for every provider/model pair.
export async function resolveModelInfo(sdk: RunInput["sdk"], model: RunInput["model"]): Promise<ModelInfo> {
  return runtime.runPromise((svc) => svc.resolveModelInfo(sdk, model)).catch(() => emptyModelInfo())
}

// Fetches session messages to determine if this is the first turn and build prompt history.
export async function resolveSessionInfo(
  sdk: RunInput["sdk"],
  sessionID: string,
  model: RunInput["model"],
): Promise<SessionInfo> {
  return runtime.runPromise((svc) => svc.resolveSessionInfo(sdk, sessionID, model)).catch(() => emptySessionInfo())
}

// Reads keybind overrides from TUI config and merges them with defaults.
// Always ensures <leader>t is present in the variant cycle binding.
export async function resolveFooterKeybinds(): Promise<FooterKeybinds> {
  return runtime.runPromise((svc) => svc.resolveFooterKeybinds()).catch(() => DEFAULT_KEYBINDS)
}

export async function resolveDiffStyle(): Promise<RunDiffStyle> {
  return runtime.runPromise((svc) => svc.resolveDiffStyle()).catch(() => "auto")
}
