import { isString, isObject } from "effect/Predicate"
import { expect, test } from "bun:test"
import { statSync } from "node:fs"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Configuration } from "electron-builder"
import { getConfig } from "./electron-builder.config"
import { CLI_BINARIES, nodePtyPackage } from "./scripts/utils"

// Use electron-builder's matcher so the tests also cover its glob and directory traversal semantics.
const { FileMatcher } = createRequire(import.meta.resolve("electron-builder"))("app-builder-lib/out/fileMatcher")

const channels = [
  { channel: "dev", appId: "ai.opencode.desktop" },
  { channel: "beta", appId: "ai.opencode.desktop.beta" },
  { channel: "prod", appId: "ai.opencode.desktop" },
] as const

function load(channel: string, target?: string): Configuration {
  const previous = process.env.OPENCODE_CHANNEL
  const previousTarget = process.env.OPENCODE_CLI_TARGET
  process.env.OPENCODE_CHANNEL = channel

  if (target !== undefined) process.env.OPENCODE_CLI_TARGET = target
  else delete process.env.OPENCODE_CLI_TARGET

  try {
    return getConfig()
  } finally {
    delete process.env.OPENCODE_CHANNEL
    delete process.env.OPENCODE_CLI_TARGET

    if (previous !== undefined) process.env.OPENCODE_CHANNEL = previous

    if (previousTarget !== undefined) process.env.OPENCODE_CLI_TARGET = previousTarget
  }
}

function trimFilter(dir: string, config: Configuration) {
  return new FileMatcher(dir, "", (value: string) => value, [
    "**/*",
    ...(Array.isArray(config.files) ? config.files : []).filter(
      (value): value is string => isString(value) && value.startsWith("!"),
    ),
  ]).createFilter()
}

test.each(channels)("channel identity for $channel", ({ channel, appId }) => {
  const config = load(channel)
  expect(config.appId).toBe(appId)
  expect(config.extraMetadata?.desktopName).toBe(`${appId}.desktop`)
  // The executable must never end in `.desktop`: libappimage resolves the
  // AppImage's desktop entry by globbing `*.desktop`, and an ELF matching
  // that glob breaks integration (anomalyco/opencode#51867).
  expect(config.linux?.executableName).toBe(appId.replace(/\.desktop$/, ""))
  expect(config.linux?.executableName).not.toMatch(/\.desktop$/)
  // The installed `.desktop` filename still derives from `desktopName` so
  // window association (StartupWMClass/desktop file basename) is unchanged.
  expect(config.linux?.syncDesktopName).toBe(true)
  expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(appId)

  for (const fpm of [config.deb?.fpm, config.rpm?.fpm]) {
    expect(fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${appId}.metainfo.xml`))
    expect(
      fpm?.some((entry) => entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop")),
    ).toBe(channel === "prod")
  }

  // Shared Electron binaries must not ship /usr/lib/.build-id links that collide with other Electron RPMs.
  // fpm rejects flags after the first src=dest mapping, so the flag must come first.
  expect(config.rpm?.fpm?.[0]).toBe("--rpm-rpmbuild-define=_build_id_links none")
  expect(config.deb?.fpm).not.toContain("--rpm-rpmbuild-define=_build_id_links none")
})

test("legacy Linux launcher stays hidden", async () => {
  const desktop = await Bun.file(path.join(import.meta.dirname, "resources/linux/opencode-desktop.desktop")).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode %U")
  expect(desktop).toContain("Icon=ai.opencode")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("shared packaging defaults", async () => {
  const config = load("dev")
  expect(config.mac?.sign).toBeFunction()
  expect(config.dmg?.sign).not.toBe(true)
  expect(config.mac?.extendInfo?.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac).toBe(true)
  const include = path.join(import.meta.dirname, "resources/windows/installer.nsh")
  expect(config.nsis?.include).toBe(include)
  expect(await Bun.file(include).exists()).toBe(true)
  expect(config.files).toContain("!resources/opencode-cli*")
})

test("trims external dependencies without excluding runtime files", () => {
  const fileStats = statSync(import.meta.filename)
  const dirStats = statSync(import.meta.dirname)
  const filter = trimFilter(import.meta.dirname, load("dev"))

  for (const prefix of ["node_modules/", "node_modules/parent/node_modules/"]) {
    const included = (file: string, stats = fileStats) => filter(path.join(import.meta.dirname, prefix, file), stats)

    // One file for each excluded pattern, including each brace alternative.
    for (const file of [
      "@zip.js/zip.js/dist/zip.js",
      ...["index.cjs", "index.min.js", "index-fflate.js", "deno.json", "eslint.config.mjs"].map(
        (name) => `@zip.js/zip.js/${name}`,
      ),
      ...["d.ts", "d.cts", "d.mts", "d.ts.map", "d.cts.map", "d.mts.map", "js.map", "cjs.map", "mjs.map"].map(
        (extension) => `unrelated/dist/index.${extension}`,
      ),
      "ajv/lib/core.ts",
      "ajv-formats/src/formats.ts",
      "js-yaml/dist/js-yaml.js",
      "js-yaml/dist/js-yaml.min.js",
      "js-yaml/dist/js-yaml.mjs.map",
      "js-yaml/bin/js-yaml.js",
    ]) {
      expect(included(file)).toBe(false)
    }

    for (const file of [
      "@zip.js/zip.js/index.js",
      "@zip.js/zip.js/lib/z-worker-inline.js",
      "electron-updater/out/main.js",
      "electron-updater/out/MacUpdater.js",
      "electron-updater/out/NsisUpdater.js",
      "electron-updater/out/providers/GitHubProvider.js",
      "builder-util-runtime/out/httpExecutor.js",
      "ajv/dist/ajv.js",
      "ajv/dist/refs/json-schema-draft-07.json",
      "ajv-formats/dist/formats.js",
      "js-yaml/index.js",
      "js-yaml/dist/js-yaml.mjs",
      "unrelated/dist/index.js",
      "unrelated/dist/index.cjs",
      "unrelated/dist/data.json",
      "unrelated/src/index.ts",
      ...["@zip.js/zip.js", "electron-updater", "builder-util-runtime", "ajv", "ajv-formats", "js-yaml"].flatMap(
        (name) => [`${name}/package.json`, `${name}/LICENSE`],
      ),
    ]) {
      expect(included(file)).toBe(true)
    }

    expect(included("@zip.js/zip.js/dist", dirStats)).toBe(false)
    expect(included("@zip.js/zip.js/lib", dirStats)).toBe(true)
  }

  for (const item of CLI_BINARIES) {
    const targetFilter = trimFilter(import.meta.dirname, load("prod", item.target))
    const active = nodePtyPackage(item.target)

    for (const candidate of CLI_BINARIES) {
      const pkg = nodePtyPackage(candidate.target)
      const included = targetFilter(path.join(import.meta.dirname, "node_modules", pkg, "lib/index.js"), fileStats)
      expect(included).toBe(pkg === active)
    }
  }
})

test("the trimmed Zip.js package can still export compressed logs", async () => {
  const config = load("dev")
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-zip-package-"))
  const source = path.dirname(fileURLToPath(import.meta.resolve("@zip.js/zip.js/package.json")))
  const filter = trimFilter(dir, config)

  try {
    await cp(source, dir, {
      recursive: true,
      filter: (file) =>
        filter(path.join(dir, "node_modules/@zip.js/zip.js", path.relative(source, file)), statSync(file)),
    })
    const zip = await import(pathToFileURL(path.join(dir, "index.js")).href)
    const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"))
    await writer.add("desktop.log", new zip.BlobReader(new Blob(["diagnostic log\n".repeat(100)])))
    const reader = new zip.ZipReader(new zip.BlobReader(await writer.close()))
    const entries = await reader.getEntries()
    expect(entries.map((entry: { filename: string }) => entry.filename)).toEqual(["desktop.log"])
    expect(entries[0].compressionMethod).toBe(8)
    expect(await entries[0].getData(new zip.TextWriter())).toBe("diagnostic log\n".repeat(100))
    await reader.close()
    await zip.terminateWorkers()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test.each(channels)("bundles the CLI only in development ($channel)", async ({ channel }) => {
  const config = await load(channel)
  const cli = { from: "resources/", to: "", filter: ["opencode-cli", "opencode-cli.exe"] }
  expect(config.files).toContain("!resources/opencode-cli*")

  if (channel === "dev") {
    expect(config.extraResources).toContainEqual(cli)

    return
  }

  expect(config.extraResources).not.toContainEqual(cli)
})

test("excludes native dependencies for other platforms and Windows architectures", () => {
  for (const target of CLI_BINARIES.filter((item) => item.os === "win32")) {
    const config = load("prod", target.rustTarget)

    expect(config.win?.files).toEqual(
      expect.arrayContaining([
        "!**/node_modules/@ff-labs/fff-bin-darwin-arm64{,/**/*}",
        "!**/node_modules/@lydell/node-pty-linux-x64{,/**/*}",
        "!**/node_modules/@parcel/watcher-android-arm64{,/**/*}",
        "!**/node_modules/@yuuang/ffi-rs-linux-arm64-gnu{,/**/*}",
      ]),
    )

    const filter = trimFilter(import.meta.dirname, { files: config.win?.files })

    for (const cpu of ["arm64", "x64"]) {
      for (const pkg of [
        `@ff-labs/fff-bin-win32-${cpu}`,
        `@lydell/node-pty-win32-${cpu}`,
        `@parcel/watcher-win32-${cpu}`,
        `@yuuang/ffi-rs-win32-${cpu}-msvc`,
      ]) {
        expect(
          filter(path.join(import.meta.dirname, "node_modules", pkg, "index.js"), statSync(import.meta.filename)),
        ).toBe(cpu === target.cpu)
      }
    }
  }
})

test("bundled config excludes repository instructions and retains runtime files", async () => {
  const config = await load("dev")
  const resources = Array.isArray(config.extraResources) ? config.extraResources : []
  const entry = resources.find((item) => isObject(item) && item.from === "resources/thape-config")

  if (!entry || isString(entry)) throw new Error("Missing config packaging entry")
  const filter = new FileMatcher(import.meta.dirname, "", (value: string) => value, entry.filter).createFilter()
  const include = (name: string) => filter(path.join(import.meta.dirname, name), statSync(import.meta.filename))
  expect(include("AGENTS.md")).toBe(false)
  expect(include("opencode.json")).toBe(true)
  expect(include("plugin/index.ts")).toBe(true)
  expect(include("node_modules/effect/dist/index.js")).toBe(true)
})
