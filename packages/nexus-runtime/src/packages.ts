import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import { Configuration, type ExtensionDescriptor } from "./configuration"
import type { ExtensionManager, ExtensionModule } from "./extension-manager"
import type { HostTools } from "./host"
import { missing } from "./storage"
import { which } from "@opencode/core/util/which"
import { satisfies, validRange } from "semver"
import { configurationFields } from "./configuration-fields"

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_.-]{0,63}$/))
const Version = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Fields = Schema.Record(Schema.String, Schema.Json)
const Selection = Schema.Struct({
  name: Name,
  version: Version,
  state_schema: Schema.NonEmptyString,
  configuration_version: Schema.Int,
  configuration: Fields,
})
const Source = Schema.Struct({
  kind: Schema.Literal("package"),
  ...Selection.fields,
  previous: Schema.optional(Selection),
})
const Manifest = Schema.Struct({
  name: Name,
  id: Name,
  display_name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  state_schema: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  configuration_version: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  configuration_schema: Schema.optional(Fields),
  defaults: Schema.optional(Fields),
  default_enabled: Schema.optional(Schema.Boolean),
  restart_only: Schema.optional(Schema.Boolean),
  requires: Schema.optional(Schema.Array(Name)),
  configuration_migrations: Schema.optional(Schema.String),
  entry: Schema.optional(Schema.String),
  webui: Schema.optional(Schema.String),
})
const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("package.list") }),
  Schema.Struct({ action: Schema.Literal("package.install"), path: Schema.NonEmptyString }),
  Schema.Struct({ action: Schema.Literal("package.check"), name: Name, version: Schema.optional(Version) }),
  Schema.Struct({
    action: Schema.Literal("package.activate"),
    name: Name,
    version: Schema.optional(Version),
    configuration: Schema.optional(Fields),
  }),
  Schema.Struct({ action: Schema.Literals(["package.disable", "package.rollback"]), name: Name }),
])

/** Immutable local source; the configuration document is the sole durable selection. */
export class Packages {
  private queue = Promise.resolve()
  private readonly root: string

  constructor(
    storage: string,
    private readonly configuration: Configuration,
    private readonly host?: HostTools,
  ) {
    this.root = join(storage, "extensions", "managed")
  }

  async command(value: unknown, manager: ExtensionManager, signal: AbortSignal) {
    const command = Schema.decodeUnknownSync(Command)(value)
    const operation = this.queue.then(async () => {
      if (command.action === "package.list") return this.list()
      if (command.action === "package.install") return this.install(command.path)
      if (command.action === "package.check") return this.check(command.name, command.version, signal)
      if (command.action === "package.activate")
        return this.activate(command.name, command.version, command.configuration, manager)
      const current = this.selected().find((row) => row.source.name === command.name)

      if (!current) throw new Error("No selected package: " + command.name)
      if (command.action === "package.disable") return manager.change({ id: current.id, enabled: false })
      if (!current.source.previous) throw new Error("This package has no previous version.")
      const previous = current.source.previous
      const manifest = await this.manifest(previous.name, previous.version)

      if (
        manifest.descriptor.id !== current.id ||
        manifest.descriptor.configuration_version !== previous.configuration_version
      )
        throw new Error("Rollback requires configuration matching the selected version.")
      this.compatible(current.source, previous)
      await dependencies(manifest.directory, manifest.document.dependencies ?? {})
      return manager.replace(await this.module(manifest), {
        enabled: true,
        configuration: { ...manifest.descriptor.defaults, ...previous.configuration },
        source: { kind: "package", ...previous, previous: this.snapshot(current.id, current.source) },
      })
    })

    this.queue = operation.then(
      () => {},
      () => {},
    )
    return operation
  }

  async sources(): Promise<ExtensionModule[]> {
    return Promise.all(
      this.selected().map(async (selection) => {
        // Keep unavailable packages visible in inventory without preventing unrelated services from booting.
        return this.manifest(selection.source.name, selection.source.version)
          .then(async (manifest) => {
            if (manifest.descriptor.id !== selection.id) throw new Error("The selected package changed identity.")
            return this.module(manifest)
          })
          .catch((error: unknown) => ({
            descriptor: {
              id: selection.id,
              name: selection.source.name,
              description: "Unavailable managed package",
              default_enabled: false,
              configuration_version: selection.source.configuration_version,
              configuration_schema: { type: "object" },
              defaults: {},
            },
            register() {
              throw error
            },
          }))
      }),
    )
  }

  async list() {
    const selected = this.selected()
    const names = await readdir(this.root).catch((error: unknown) => {
      if (missing(error)) return []
      throw error
    })
    const packages = await Promise.all(
      names
        .filter((name) => /^[a-z][a-z0-9_.-]{0,63}$/.test(name))
        .flatMap(async (name) => {
          const versions = await readdir(join(this.root, name))
          return Promise.all(
            versions
              .filter((version) => /^[0-9a-f]{64}$/.test(version))
              .map(async (version) => {
                const manifest = await this.manifest(name, version)
                const current = selected.find((row) => row.id === manifest.descriptor.id)
                const chosen = current?.source.name === name && current.source.version === version
                return {
                  name,
                  id: manifest.descriptor.id,
                  version,
                  description: manifest.descriptor.description,
                  state_schema: manifest.document.state_schema ?? "none",
                  dependencies: manifest.document.dependencies ?? {},
                  configuration_version: manifest.descriptor.configuration_version,
                  selected: chosen,
                  enabled: chosen && this.configuration.selection(manifest.descriptor).enabled,
                  previous: current?.source.previous?.name === name && current.source.previous.version === version,
                }
              }),
          )
        }),
    )
    return { packages: packages.flat().sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version)) }
  }

  async install(path: string) {
    const source = resolve(path)
    const manifest = await readManifest(source)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(this.root, ".install-"))

    try {
      for (const file of await files(source)) {
        await mkdir(dirname(join(staging, file)), { recursive: true, mode: 0o700 })
        await copyFile(join(source, file), join(staging, file))
      }
      const version = await digest(staging)
      const destination = join(this.root, manifest.document.name, version)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const exists = await lstat(destination).catch((error: unknown) => {
        if (missing(error)) return
        throw error
      })

      if (!exists) await rename(staging, destination)
      if (exists && (!exists.isDirectory() || (await digest(destination)) !== version))
        throw new Error("Installed package bytes were modified.")
      return { name: manifest.document.name, id: manifest.descriptor.id, version, installed: true }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async check(name: string, requested: string | undefined, signal: AbortSignal) {
    const version = await this.version(name, requested)
    const manifest = await this.manifest(name, version)
    await dependencies(manifest.directory, manifest.document.dependencies ?? {})
    const tests = (await files(manifest.directory)).filter(
      (file) => /^test\//.test(file) && /[._](test|spec)\.[cm]?[jt]sx?$/.test(file),
    )

    if (!tests.length)
      return {
        name,
        version,
        checked: true,
        tests: 0,
        passed: true,
        output: "No test files; structure and dependencies checked.",
      }
    if (!this.host) throw new Error("Package tests require OpenCode process services.")
    const bun = which("bun")
    if (!bun) throw new Error("Install Bun to run extension package tests.")
    const result = await this.host.process(
      manifest.directory,
      bun,
      ["test", ...tests.map((file) => "./" + file)],
      signal,
    )
    return {
      name,
      version,
      checked: true,
      tests: tests.length,
      passed: !result.timedOut && result.exitCode === 0,
      exit_status: result.timedOut ? null : result.exitCode,
      timed_out: result.timedOut,
      output: (result.output ?? result.stdout).toString("utf8"),
      truncated: result.outputTruncated ?? false,
    }
  }

  private async activate(
    name: string,
    requested: string | undefined,
    configuration: Record<string, Schema.Json> | undefined,
    manager: ExtensionManager,
  ) {
    const version = await this.version(name, requested)
    const manifest = await this.manifest(name, version)
    const current = this.selected().find((row) => row.id === manifest.descriptor.id)
    if (current && current.source.name !== name) throw new Error("This extension already has another package source.")
    const candidate = await this.module(manifest)
    const saved = this.configuration.saved(manifest.descriptor.id)
    const from = saved?.configuration_version ?? manifest.descriptor.configuration_version
    const overrides =
      configuration ??
      (from === manifest.descriptor.configuration_version
        ? (saved?.configuration ?? {})
        : candidate.descriptor.migrate?.(saved?.configuration ?? {}, from))
    if (!overrides) throw new Error("This package cannot migrate its saved configuration.")
    const selection = {
      name,
      version,
      state_schema: manifest.document.state_schema ?? "none",
      configuration_version: manifest.descriptor.configuration_version,
      configuration: overrides,
    }
    if (current) this.compatible(current.source, selection)
    await dependencies(manifest.directory, manifest.document.dependencies ?? {})
    const previous =
      current && current.source.version !== version
        ? this.snapshot(current.id, current.source)
        : current?.source.previous
    return manager.replace(candidate, {
      enabled: true,
      configuration: { ...manifest.descriptor.defaults, ...overrides },
      source: { kind: "package", ...selection, ...(previous ? { previous } : {}) },
    })
  }

  private snapshot(id: string, source: typeof Source.Type) {
    const saved = this.configuration.saved(id)!
    return {
      name: source.name,
      version: source.version,
      state_schema: source.state_schema,
      configuration_version: saved.configuration_version!,
      configuration: saved.configuration,
    }
  }

  private compatible(current: typeof Selection.Type, candidate: typeof Selection.Type) {
    if (current.state_schema !== candidate.state_schema)
      throw new Error("Activation requires business-state recovery: state_schema differs.")
  }

  private selected() {
    return this.configuration
      .sources()
      .filter((row) => row.source.kind === "package")
      .map((row) => ({ id: row.id, source: Schema.decodeUnknownSync(Source)(row.source) }))
  }

  private async version(name: string, requested?: string) {
    Schema.decodeUnknownSync(Name)(name)
    if (requested) return Schema.decodeUnknownSync(Version)(requested)
    const selected = this.selected().find((row) => row.source.name === name)
    if (selected) return selected.source.version
    const versions = (await readdir(join(this.root, name))).filter((version) => /^[0-9a-f]{64}$/.test(version))
    if (versions.length !== 1) throw new Error("Select one full installed package version.")
    return versions[0]
  }

  private async manifest(name: string, version: string) {
    Schema.decodeUnknownSync(Name)(name)
    Schema.decodeUnknownSync(Version)(version)
    const directory = join(this.root, name, version)
    const manifest = await readManifest(directory)
    if (manifest.document.name !== name || (await digest(directory)) !== version)
      throw new Error("Installed package identity or bytes were modified.")
    return manifest
  }

  private async module(manifest: Awaited<ReturnType<typeof readManifest>>): Promise<ExtensionModule> {
    const descriptor = { ...manifest.descriptor }
    const saved = this.configuration.saved(descriptor.id)
    if (
      manifest.document.configuration_migrations &&
      saved &&
      (saved.configuration_version ?? descriptor.configuration_version) < descriptor.configuration_version
    ) {
      const migration = await import(
        pathToFileURL(inside(manifest.directory, manifest.document.configuration_migrations)).href
      )
      if (typeof migration.migrate !== "function")
        throw new Error("Configuration migrations require a migrate(configuration, from) export.")
      descriptor.migrate = migration.migrate
    }
    return {
      descriptor,
      async register(api) {
        await dependencies(manifest.directory, manifest.document.dependencies ?? {})
        const { workerRegistration } = await import("./worker-extension")
        if (manifest.document.webui) await api.registerWebUI(inside(manifest.directory, manifest.document.webui))
        await workerRegistration(manifest.entry)(api)
      },
    }
  }
}

async function readManifest(directory: string) {
  const document = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    await readFile(join(directory, "nexus-extension.json"), "utf8"),
  )
  const entry = inside(directory, document.entry ?? "extension.ts")
  if (document.state_schema && Buffer.byteLength(document.state_schema) > 128)
    throw new Error("state_schema must contain at most 128 bytes.")
  for (const [name, requirement] of Object.entries(document.dependencies ?? {})) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(name) || !validRange(requirement))
      throw new Error("Invalid package dependency name or version requirement.")
  }
  if (!(await lstat(entry)).isFile()) throw new Error("A package needs a regular extension entry file.")
  if (document.configuration_migrations) inside(directory, document.configuration_migrations)
  const descriptor: ExtensionDescriptor = {
    id: document.id,
    name: document.display_name ?? document.name,
    description: document.description ?? "",
    default_enabled: document.default_enabled ?? false,
    configuration_version: document.configuration_version ?? 1,
    configuration_schema: document.configuration_schema ?? {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    defaults: document.defaults ?? {},
    requires: document.requires,
    restart_only: document.restart_only ?? false,
  }
  configurationFields(descriptor.configuration_schema, {}, descriptor.defaults)
  return { document, directory, entry, descriptor }
}

function inside(directory: string, path: string) {
  const absolute = resolve(directory, path)
  if (isAbsolute(path) || !absolute.startsWith(resolve(directory) + sep))
    throw new Error("Package entries must be relative files within the package.")
  return absolute
}

async function files(root: string, relative = ""): Promise<string[]> {
  const paths = await readdir(join(root, relative), { withFileTypes: true })
  const result = await Promise.all(
    paths
      .filter((entry) => entry.name !== ".git")
      .map(async (entry) => {
        const path = relative ? relative + "/" + entry.name : entry.name
        if (entry.isDirectory()) return files(root, path)
        if (!entry.isFile()) throw new Error("Managed package files must be regular files: " + path)
        return [path]
      }),
  )
  return result.flat().sort()
}

async function digest(directory: string) {
  const hash = createHash("sha256")
  for (const file of await files(directory)) {
    hash.update(file + "\0" + (await lstat(join(directory, file))).size + "\0")
    for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk)
  }
  return hash.digest("hex")
}

async function dependencies(directory: string, requirements: Record<string, string>) {
  for (const [name, requirement] of Object.entries(requirements)) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(name)) throw new Error("Invalid package dependency name.")
    const paths = createRequire(pathToFileURL(join(directory, "package.json"))).resolve.paths(name) ?? []
    const documents = await Promise.all(
      paths.map((path) =>
        readFile(join(path, name, "package.json"), "utf8").catch((error: unknown) => {
          if (missing(error)) return
          throw error
        }),
      ),
    )
    const source = documents.find((document) => document !== undefined)
    const document = source
      ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(source)
      : undefined
    if (!document || !satisfies(document.version, requirement))
      throw new Error(name + " " + requirement + " is unavailable; install a compatible dependency before activation.")
  }
}
