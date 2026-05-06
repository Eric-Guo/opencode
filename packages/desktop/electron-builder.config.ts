import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
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
  },
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*", "!resources/thape-config/**"],
  extraResources: [
    {
      from: "resources/thape-config",
      to: "thape-config",
      filter: ["**/*", "!**/.git/**"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
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
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
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
