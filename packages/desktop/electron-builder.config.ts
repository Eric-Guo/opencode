import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const thapeConfigDir = path.join(packageDir, "resources", "thape-config")
const generatedDir = path.join(packageDir, "out", "generated")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const appFiles = [
  "out/**/*",
  "resources/**/*",
  "!out/**/assets/wasm-*.js.map",
  "!resources/opencode-cli*",
  "!resources/thape-config/**",
  "!resources/icons/**",
]
const windowsNativeExclusions = [
  "@ff-labs/fff-bin-android-arm64",
  "@ff-labs/fff-bin-darwin-arm64",
  "@ff-labs/fff-bin-darwin-x64",
  "@ff-labs/fff-bin-linux-arm64-gnu",
  "@ff-labs/fff-bin-linux-arm64-musl",
  "@ff-labs/fff-bin-linux-x64-gnu",
  "@ff-labs/fff-bin-linux-x64-musl",
  "@lydell/node-pty-darwin-arm64",
  "@lydell/node-pty-darwin-x64",
  "@lydell/node-pty-linux-arm64",
  "@lydell/node-pty-linux-x64",
  "@parcel/watcher-android-arm64",
  "@parcel/watcher-darwin-arm64",
  "@parcel/watcher-darwin-x64",
  "@parcel/watcher-freebsd-x64",
  "@parcel/watcher-linux-arm-glibc",
  "@parcel/watcher-linux-arm-musl",
  "@parcel/watcher-linux-arm64-glibc",
  "@parcel/watcher-linux-arm64-musl",
  "@parcel/watcher-linux-x64-glibc",
  "@parcel/watcher-linux-x64-musl",
  "@parcel/watcher-win32-ia32",
  "@msgpackr-extract/msgpackr-extract-darwin-arm64",
  "@msgpackr-extract/msgpackr-extract-darwin-x64",
  "@msgpackr-extract/msgpackr-extract-linux-arm",
  "@msgpackr-extract/msgpackr-extract-linux-arm64",
  "@msgpackr-extract/msgpackr-extract-linux-x64",
  "@yuuang/ffi-rs-android-arm64",
  "@yuuang/ffi-rs-darwin-arm64",
  "@yuuang/ffi-rs-darwin-x64",
  "@yuuang/ffi-rs-linux-arm-gnueabihf",
  "@yuuang/ffi-rs-linux-arm64-gnu",
  "@yuuang/ffi-rs-linux-arm64-musl",
  "@yuuang/ffi-rs-linux-x64-gnu",
  "@yuuang/ffi-rs-linux-x64-musl",
  "@yuuang/ffi-rs-win32-ia32-msvc",
].map((packageName) => `!**/node_modules/${packageName}{,/**/*}`)
const windowsArchitectureExclusions = (
  process.env.RUST_TARGET === "x86_64-pc-windows-msvc"
    ? [
        "@ff-labs/fff-bin-win32-arm64",
        "@lydell/node-pty-win32-arm64",
        "@parcel/watcher-win32-arm64",
        "@yuuang/ffi-rs-win32-arm64-msvc",
      ]
    : process.env.RUST_TARGET === "aarch64-pc-windows-msvc"
      ? [
          "@ff-labs/fff-bin-win32-x64",
          "@lydell/node-pty-win32-x64",
          "@msgpackr-extract/msgpackr-extract-win32-x64",
          "@parcel/watcher-win32-x64",
          "@yuuang/ffi-rs-win32-x64-msvc",
        ]
      : []
).map((packageName) => `!**/node_modules/${packageName}{,/**/*}`)
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.opencode.desktop",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const iconChannel = channel === "dev" ? "prod" : channel
const iconDir = `icons/${iconChannel}`
const updateUrl = `https://cybros.thape.com.cn/system/opencode/desktop/${channel}`

const getBase = (appId: string): Configuration => ({
  artifactName: "SigmaAgents-${os}-${arch}-${version}.${ext}",
  // Native dependencies are shipped as platform-specific prebuilt packages. Rebuilding them
  // prevents packaging another platform because node-gyp does not support cross-compilation.
  npmRebuild: false,
  beforePack: async () => {
    await execFileAsync("bun", ["install", "--cwd", thapeConfigDir])
    await mkdir(generatedDir, { recursive: true })
    await writeFile(
      path.join(generatedDir, "app-update.yml"),
      `provider: generic\nurl: ${updateUrl}\nchannel: latest\n`,
      "utf8",
    )
  },
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: appFiles,
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: iconDir,
      to: "icons",
      filter: ["icon.ico", "icon.png", "dock.png"],
    },
    {
      from: "resources/thape-config",
      to: "thape-config",
      filter: [
        "**/*",
        "!**/.git/**",
        "!node_modules/**/*.d.ts",
        "!node_modules/effect/src/**",
        "!node_modules/zod/src/**",
        "!node_modules/@opencode-ai/plugin/node_modules/zod/src/**",
      ],
    },
    {
      from: "resources/thape-config/node_modules",
      to: "thape-config/node_modules",
      filter: [
        "**/*",
        "!**/*.d.ts",
        "!effect/src/**",
        "!zod/src/**",
        "!@opencode-ai/plugin/node_modules/zod/src/**",
      ],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      from: "out/generated/app-update.yml",
      to: "app-update.yml",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `${iconDir}/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dir"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "OpenCode",
    schemes: ["opencode"],
  },
  win: {
    icon: `${iconDir}/icon.ico`,
    electronLanguages: ["en-US", "zh-CN"],
    files: [...appFiles, ...windowsNativeExclusions, ...windowsArchitectureExclusions],
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `${iconDir}/icon.ico`,
    installerHeaderIcon: `${iconDir}/icon.ico`,
  },
  linux: {
    icon: iconDir,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "SigmaAgents",
        publish: { provider: "generic", url: updateUrl, channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "sigma-agents", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "generic", url: updateUrl, channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: { provider: "generic", url: updateUrl, channel: "latest" },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "opencode", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
