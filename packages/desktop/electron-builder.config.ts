import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const thapeConfigDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "resources/thape-config")
const generatedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "out/generated")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

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
const iconChannel = channel === "dev" ? "prod" : channel
const iconDir = `icons/${iconChannel}`
const updateUrl = `https://cybros.thape.com.cn/system/opencode/desktop/${channel}`

const getBase = (): Configuration => ({
  artifactName: "SigmaAgents-${os}-${arch}-${buildVersion}.${ext}",
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
  files: ["out/**/*", "resources/**/*", "!resources/thape-config/**", "!resources/icons/**"],
  extraResources: [
    {
      from: iconDir,
      to: "icons",
    },
    {
      from: "resources/thape-config",
      to: "thape-config",
      filter: ["**/*", "!**/.git/**"],
    },
    {
      from: "resources/thape-config/node_modules",
      to: "thape-config/node_modules",
      filter: ["**/*"],
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
    executableName: "opencode-desktop",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.opencode.desktop",
        productName: "SigmaAgents",
        publish: { provider: "generic", url: updateUrl, channel: "latest" },
        rpm: { packageName: "sigma-agents" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.opencode.desktop.beta",
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "generic", url: updateUrl, channel: "latest" },
        rpm: { packageName: "opencode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.opencode.desktop",
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: { provider: "generic", url: updateUrl, channel: "latest" },
        rpm: { packageName: "opencode" },
      }
    }
  }
}

export default getConfig()
