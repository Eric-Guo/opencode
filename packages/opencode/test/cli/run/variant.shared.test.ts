import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import {
  createVariantRuntime,
  cycleVariant,
  formatModelLabel,
  pickVariant,
  resolveVariant,
} from "@/cli/cmd/run/variant.shared"
import type { SessionMessages } from "@/cli/cmd/run/session.shared"
import { testEffect } from "../../lib/effect"

const model = {
  providerID: "openai",
  modelID: "gpt-5",
}

function userMessage(id: string, input: { providerID: string; modelID: string; variant?: string }): SessionMessages[number] {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "user",
      time: {
        created: 1,
      },
      agent: "build",
      model: input,
    },
    parts: [],
  }
}

const it = testEffect(Layer.mergeAll(AppFileSystem.defaultLayer, NodeFileSystem.layer))

function remap(root: string, file: string) {
  if (file === Global.Path.state) {
    return root
  }

  if (file.startsWith(Global.Path.state + path.sep)) {
    return path.join(root, path.relative(Global.Path.state, file))
  }

  return file
}

function remappedFs(root: string) {
  return Layer.effect(
    AppFileSystem.Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      return AppFileSystem.Service.of({
        ...fs,
        readJson: (file) => fs.readJson(remap(root, file)),
        writeJson: (file, data, mode) => fs.writeJson(remap(root, file), data, mode),
      })
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
}

describe("run variant shared", () => {
  test("prefers cli then session then saved variants", () => {
    expect(resolveVariant("max", "high", "low", ["low", "high"])).toBe("max")
    expect(resolveVariant(undefined, "high", "low", ["low", "high"])).toBe("high")
    expect(resolveVariant(undefined, "missing", "low", ["low", "high"])).toBe("low")
  })

  test("cycles through variants and back to default", () => {
    expect(cycleVariant(undefined, ["low", "high"])).toBe("low")
    expect(cycleVariant("low", ["low", "high"])).toBe("high")
    expect(cycleVariant("high", ["low", "high"])).toBeUndefined()
    expect(cycleVariant(undefined, [])).toBeUndefined()
  })

  test("formats model labels", () => {
    expect(formatModelLabel(model, undefined)).toBe("gpt-5 · openai")
    expect(formatModelLabel(model, "high")).toBe("gpt-5 · openai · high")
  })

  test("picks the latest matching variant from raw session messages", () => {
    const msgs: SessionMessages = [
      userMessage("msg-1", { providerID: "openai", modelID: "gpt-5", variant: "high" }),
      userMessage("msg-2", { providerID: "anthropic", modelID: "sonnet", variant: "max" }),
      userMessage("msg-3", { providerID: "openai", modelID: "gpt-5", variant: "minimal" }),
    ]

    expect(pickVariant(model, msgs)).toBe("minimal")
  })

  it.live("reads and writes saved variants through a runtime-backed app fs layer", () =>
    Effect.gen(function* () {
      const filesys = yield* FileSystem.FileSystem
      const fs = yield* AppFileSystem.Service
      const root = yield* filesys.makeTempDirectoryScoped()
      const file = path.join(root, "model.json")

      yield* fs.writeJson(file, {
        recent: [{ providerID: "anthropic", modelID: "sonnet" }],
        variant: {
          "openai/gpt-4.1": "low",
        },
      })

      const svc = createVariantRuntime(remappedFs(root))

      yield* Effect.promise(() => svc.saveVariant(model, "high"))
      expect(yield* Effect.promise(() => svc.resolveSavedVariant(model))).toBe("high")
      expect(yield* fs.readJson(file)).toEqual({
        recent: [{ providerID: "anthropic", modelID: "sonnet" }],
        variant: {
          "openai/gpt-4.1": "low",
          "openai/gpt-5": "high",
        },
      })

      yield* Effect.promise(() => svc.saveVariant(model, undefined))
      expect(yield* Effect.promise(() => svc.resolveSavedVariant(model))).toBeUndefined()
      expect(yield* fs.readJson(file)).toEqual({
        recent: [{ providerID: "anthropic", modelID: "sonnet" }],
        variant: {
          "openai/gpt-4.1": "low",
        },
      })
    }),
  )

  it.live("repairs malformed saved variant state on the next write", () =>
    Effect.gen(function* () {
      const filesys = yield* FileSystem.FileSystem
      const fs = yield* AppFileSystem.Service
      const root = yield* filesys.makeTempDirectoryScoped()
      const file = path.join(root, "model.json")

      yield* filesys.writeFileString(file, "{")

      const svc = createVariantRuntime(remappedFs(root))

      yield* Effect.promise(() => svc.saveVariant(model, "high"))
      expect(yield* Effect.promise(() => svc.resolveSavedVariant(model))).toBe("high")
      expect(yield* fs.readJson(file)).toEqual({
        variant: {
          "openai/gpt-5": "high",
        },
      })
    }),
  )
})
