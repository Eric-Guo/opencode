import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import {
  resolveDiffStyle,
  resolveFooterKeybinds,
  resolveModelInfo,
  resolveSessionInfo,
} from "@/cli/cmd/run/runtime.boot"
import type { RunInput } from "@/cli/cmd/run/types"

describe("run runtime boot", () => {
  afterEach(() => {
    mock.restore()
  })

  test("merges footer keybind config and injects leader cycle once", async () => {
    spyOn(TuiConfig, "get").mockResolvedValue({
      keybinds: {
        leader: " ctrl+g ",
        variant_cycle: " ctrl+t, <leader>t , alt+t ",
        session_interrupt: " ctrl+c ",
        history_previous: " k ",
        history_next: " j ",
        input_submit: " ctrl+s ",
        input_newline: " alt+return ",
      },
    })

    await expect(resolveFooterKeybinds()).resolves.toEqual({
      leader: "ctrl+g",
      variantCycle: "ctrl+t,<leader>t,alt+t",
      interrupt: "ctrl+c",
      historyPrevious: "k",
      historyNext: "j",
      inputSubmit: "ctrl+s",
      inputNewline: "alt+return",
    })
  })

  test("falls back to default keybinds when config load fails", async () => {
    spyOn(TuiConfig, "get").mockRejectedValue(new Error("boom"))

    await expect(resolveFooterKeybinds()).resolves.toEqual({
      leader: "ctrl+x",
      variantCycle: "ctrl+t,<leader>t",
      interrupt: "escape",
      historyPrevious: "up",
      historyNext: "down",
      inputSubmit: "return",
      inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
    })
  })

  test("collects model variants and context limits", async () => {
    const sdk = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                models: {
                  "gpt-5": {
                    variants: {
                      high: {},
                      minimal: {},
                    },
                    limit: {
                      context: 128000,
                    },
                  },
                },
              },
              {
                id: "anthropic",
                models: {
                  sonnet: {
                    limit: {
                      context: 200000,
                    },
                  },
                },
              },
            ],
          },
        }),
      },
    } as unknown as RunInput["sdk"]

    await expect(resolveModelInfo(sdk, { providerID: "openai", modelID: "gpt-5" })).resolves.toEqual({
      variants: ["high", "minimal"],
      limits: {
        "openai/gpt-5": 128000,
        "anthropic/sonnet": 200000,
      },
    })
  })

  test("resolves session history and latest session variant", async () => {
    const sdk = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "ignore" }],
            },
            {
              info: {
                role: "user",
                model: {
                  providerID: "openai",
                  modelID: "gpt-5",
                  variant: "high",
                },
              },
              parts: [{ type: "text", text: "hello" }],
            },
          ],
        }),
      },
    } as unknown as RunInput["sdk"]

    await expect(resolveSessionInfo(sdk, "session-1", { providerID: "openai", modelID: "gpt-5" })).resolves.toEqual({
      first: false,
      history: [{ text: "hello", parts: [] }],
      variant: "high",
    })
  })

  test("falls back when session lookup fails", async () => {
    const sdk = {
      session: {
        messages: async () => {
          throw new Error("boom")
        },
      },
    } as unknown as RunInput["sdk"]

    await expect(resolveSessionInfo(sdk, "session-1", { providerID: "openai", modelID: "gpt-5" })).resolves.toEqual({
      first: true,
      history: [],
      variant: undefined,
    })
  })

  test("reads diff style and falls back to auto", async () => {
    spyOn(TuiConfig, "get").mockResolvedValue({ diff_style: "stacked" })
    await expect(resolveDiffStyle()).resolves.toBe("stacked")

    mock.restore()
    spyOn(TuiConfig, "get").mockRejectedValue(new Error("boom"))
    await expect(resolveDiffStyle()).resolves.toBe("auto")
  })
})
