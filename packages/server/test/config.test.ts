import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/schema/config"
import { Skill } from "@opencode/schema/skill"
import { Location } from "@opencode/schema/location"
import { Effect, Schedule, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode/schema/schema"

it.live("loads standard user, selected global, and project skills and writes to the selected directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-layers-")))
    const global = path.join(tmp.path, "home", ".config", "opencode")
    const custom = path.join(tmp.path, "custom-config")
    const project = path.join(tmp.path, "project")
    const directories = [global, custom, path.join(project, ".opencode")].map((directory) =>
      AbsolutePath.make(directory),
    )
    yield* Effect.promise(() =>
      Promise.all(
        directories.map(async (directory, index) => {
          await fs.mkdir(path.join(directory, "skills", `unique-${index}`), { recursive: true })
          await fs.mkdir(path.join(directory, "skills", "shared"), { recursive: true })
          await Bun.write(path.join(directory, "opencode.jsonc"), JSON.stringify({ shell: `shell-${index}` }))
          await Bun.write(path.join(directory, "skills", `unique-${index}`, "SKILL.md"), `# Unique ${index}`)
          await Bun.write(path.join(directory, "skills", "shared", "SKILL.md"), `# Shared ${index}`)
        }),
      ),
    )
    const server = yield* startServer(custom, global)
    const configUrl = new URL("/api/config", server.base)
    configUrl.searchParams.set("location[directory]", project)
    const configResponse = yield* Effect.promise(() => fetch(configUrl, { headers: server.headers }))
    const entries = yield* Effect.promise(() => configResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Config.Entry))),
    )
    expect(configResponse.status).toBe(200)
    expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual(directories)
    expect(entries.flatMap((entry) => (entry.type === "document" ? [entry.info.shell] : []))).toEqual([
      "shell-0",
      "shell-1",
      "shell-2",
    ])

    const skillUrl = new URL("/api/skill", server.base)
    skillUrl.searchParams.set("location[directory]", project)
    const listSkills = Effect.gen(function* () {
      const response = yield* Effect.promise(() => fetch(skillUrl, { headers: server.headers }))
      expect(response.status).toBe(200)
      return yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Location.response(Schema.Array(Skill.Info)))),
      )
    }).pipe(
      Effect.repeat({
        while: (result) => !result.data.some((skill) => skill.id === "shared"),
        schedule: Schedule.spaced("10 millis"),
      }),
      Effect.timeout("5 seconds"),
    )
    const skills = yield* listSkills
    expect(skills.data.map((skill) => skill.id)).toEqual(expect.arrayContaining(["unique-0", "unique-1", "unique-2"]))
    expect(skills.data.find((skill) => skill.id === "shared")?.content).toBe("# Shared 2")

    skillUrl.searchParams.set("location[directory]", custom)
    const userSkills = yield* listSkills
    expect(userSkills.data.find((skill) => skill.id === "shared")?.content).toBe("# Shared 1")

    const update = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "user-shell" }),
      }),
    )
    expect(update.status).toBe(204)
    expect(yield* Effect.promise(() => Bun.file(path.join(custom, "opencode.jsonc")).json())).toEqual({
      shell: "user-shell",
    })
    expect(yield* Effect.promise(() => Bun.file(path.join(global, "opencode.jsonc")).json())).toEqual({
      shell: "shell-0",
    })
  }),
)

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("updates the global shell without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
