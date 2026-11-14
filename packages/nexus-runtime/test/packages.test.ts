import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Packages } from "../src/packages"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { packageTools } from "../src/package-tools"
import { packageProcess } from "../src/host"
import { createConnection } from "node:net"
import { Schema } from "effect"

test("managed versions stay inert until activation, rollback restores configuration, and failed candidates preserve the selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-packages-"))
  const source = join(root, "source")
  const configuration = new Configuration(join(root, "settings.json"))
  const packages = new Packages(root, configuration)
  const modules = [packageTools(packages, () => manager)]
  const manager: ExtensionManager = new ExtensionManager(
    configuration,
    modules,
    root,
    new AbortController().signal,
    async () => {},
  )
  const command = (input: unknown) => packages.command(input, manager, new AbortController().signal)
  const context = {
    workspace: "workspace",
    conversation: "conversation",
    run: "run",
    task: "task",
    directory: root,
    signal: new AbortController().signal,
  }
  const manifest = {
    name: "fixture",
    id: "fixture",
    state_schema: "v1",
    default_enabled: false,
    configuration_schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    defaults: { message: "default" },
  }
  try {
    await mkdir(source)
    await Bun.write(join(source, "nexus-extension.json"), JSON.stringify(manifest))
    await Bun.write(
      join(source, "extension.ts"),
      'export function register(api) { api.registerCommand("fixture.read", async () => api.configuration.message) }',
    )
    await manager.start()
    const first = await packages.install(source)
    expect(await packages.install(source)).toEqual(first)
    expect(manager.list().map((row) => row.id)).toEqual(["nexus.packages"])
    const manage = manager.tools().find((tool) => tool.definition.name === "manage_extension")!
    const list = manager.tools().find((tool) => tool.definition.name === "list_extensions")!
    expect(manage.role).toBe("agent")
    expect(await manage.execute({ action: "install", path: "relative" }, context)).toMatchObject({ is_error: true })
    expect(JSON.parse(String((await list.execute({}, context)).content))).toMatchObject({
      packages: [{ selected: false }],
    })
    expect(await packages.list()).toMatchObject({ packages: [{ selected: false, enabled: false }] })
    expect(
      await manage.execute(
        {
          action: "activate",
          name: first.name,
          version: first.version,
          configuration: { message: "original" },
        },
        context,
      ),
    ).not.toHaveProperty("is_error")
    expect(await manager.command("fixture.read", {})).toBe("original")
    await Bun.write(
      join(source, "extension.ts"),
      'export function register(api) { api.registerCommand("fixture.read", async () => "updated:" + api.configuration.message) }',
    )
    const second = await packages.install(source)
    expect(second.version).not.toBe(first.version)
    await command({
      action: "package.activate",
      name: second.name,
      version: second.version,
      configuration: { message: "new" },
    })
    expect(await manager.command("fixture.read", {})).toBe("updated:new")
    await command({ action: "package.rollback", name: first.name })
    expect(await manager.command("fixture.read", {})).toBe("original")
    await Bun.write(join(source, "extension.ts"), 'throw new Error("candidate failed")')
    const broken = await packages.install(source)
    await expect(command({ action: "package.activate", name: broken.name, version: broken.version })).rejects.toThrow(
      "candidate failed",
    )
    expect(await manager.command("fixture.read", {})).toBe("original")
    const restored = new Configuration(join(root, "settings.json"))
    await restored.restore()
    expect(restored.saved("fixture")?.source?.version).toBe(first.version)
    expect(restored.saved("fixture")?.configuration).toEqual({ message: "original" })
    await Bun.write(join(source, "nexus-extension.json"), JSON.stringify({ ...manifest, state_schema: "v2" }))
    const incompatible = await packages.install(source)
    await expect(
      command({ action: "package.activate", name: incompatible.name, version: incompatible.version }),
    ).rejects.toThrow("business-state recovery")
    await command({ action: "package.disable", name: "fixture" })
    await manager.close()
    const next = new ExtensionManager(
      restored,
      await new Packages(root, restored).sources(),
      root,
      new AbortController().signal,
      async () => {},
    )
    await next.start()
    expect(next.list()[0].active).toBe(false)
    await next.close()
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("package check processes retain the bounded diagnostic tail and report deadlines", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-package-check-"))
  try {
    const result = await packageProcess(
      root,
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(70000) + "final diagnostic"); process.exitCode = 7'],
      new AbortController().signal,
    )
    expect(result).toMatchObject({ exitCode: 7, timedOut: false, outputTruncated: true })
    expect(result.output.length).toBe(65536)
    expect(result.output.toString()).toEndWith("final diagnostic")
    const timeout = await packageProcess(
      root,
      process.execPath,
      ["-e", "setInterval(() => {}, 10000)"],
      new AbortController().signal,
      50,
    )
    expect(timeout).toMatchObject({ exitCode: -1, timedOut: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("successful package checks release background descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-package-descendant-"))
  const script =
    'require("node:net").createServer(() => {}).listen(0, "127.0.0.1", function () { console.log(JSON.stringify({port: this.address().port, pid: process.pid})) })'
  try {
    const result = await packageProcess(
      root,
      process.execPath,
      [
        "-e",
        `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(script)}], {stdio:["ignore","pipe","ignore"]}); child.stdout.once("data", value => { process.stdout.write(value); process.exit(0) })`,
      ],
      new AbortController().signal,
    )
    expect(result).toMatchObject({ exitCode: 0, timedOut: false })
    const address = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ port: Schema.Int, pid: Schema.Int })),
    )(result.output.toString())
    const listening = async () => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port })
      const alive = await new Promise<boolean>((resolve) => {
        socket.once("error", () => resolve(false))
        socket.once("connect", () => resolve(true))
      })
      socket.destroy()
      return alive
    }
    // SIGKILL is delivered to the whole group, but kernel socket teardown can outlive the supervisor's exit.
    const deadline = Date.now() + 1000
    while ((await listening()) && Date.now() < deadline) await Bun.sleep(5)
    const alive = await listening()
    if (alive) {
      try {
        process.kill(address.pid, "SIGKILL")
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    expect(alive).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("packages reject symlink entries and detect modified installed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-package-integrity-"))
  const source = join(root, "source")
  const packages = new Packages(root, new Configuration(join(root, "settings.json")))
  try {
    await mkdir(source)
    await Bun.write(join(source, "nexus-extension.json"), JSON.stringify({ name: "fixture", id: "fixture" }))
    await Bun.write(join(source, "extension.ts"), "export function register() {}")
    const installed = await packages.install(source)
    await Bun.write(join(root, "extensions", "managed", "fixture", installed.version, "extension.ts"), "modified")
    await expect(packages.list()).rejects.toThrow("bytes were modified")
    await symlink(join(source, "extension.ts"), join(source, "link"))
    await expect(packages.install(source)).rejects.toThrow("regular files")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
