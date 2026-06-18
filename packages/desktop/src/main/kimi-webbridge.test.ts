import { describe, expect, test } from "bun:test"
import { ensureKimiWebBridgeDaemon } from "./kimi-webbridge"

describe("kimi-webbridge daemon startup", () => {
  test("checks status and does not start when already running", async () => {
    const calls: string[] = []

    await ensureKimiWebBridgeDaemon({
      dependencies: {
        homeDir: "/tmp/home",
        readFile: async () => "123",
        access: async () => undefined,
        processRunning: () => true,
        execFile: async (_file, args) => {
          calls.push(args.join(" "))
          return {
            stdout: JSON.stringify({ running: true, port: 10086, version: "v1.10.0", uptime_seconds: 4 }),
            stderr: "",
          }
        },
      },
    })

    expect(calls).toEqual(["status"])
  })

  test("starts daemon when pid is absent and status is stopped", async () => {
    const calls: string[] = []

    await ensureKimiWebBridgeDaemon({
      dependencies: {
        homeDir: "/tmp/home",
        readFile: async () => {
          throw new Error("missing")
        },
        access: async () => undefined,
        processRunning: () => false,
        execFile: async (_file, args) => {
          calls.push(args.join(" "))
          if (calls.length === 1) return { stdout: JSON.stringify({ running: false }), stderr: "" }
          return { stdout: JSON.stringify({ running: true, port: 10086 }), stderr: "" }
        },
      },
    })

    expect(calls).toEqual(["status", "start", "status"])
  })

  test("installs on Windows when the executable is missing", async () => {
    let installed = false
    const calls: { file: string; args: string[]; timeout?: number }[] = []

    await ensureKimiWebBridgeDaemon({
      dependencies: {
        homeDir: "C:\\Users\\zhangxiaohui",
        platform: "win32",
        readFile: async () => {
          throw new Error("missing")
        },
        access: async (path) => {
          if (installed && path === "C:\\Users\\zhangxiaohui\\.kimi-webbridge\\bin\\kimi-webbridge.exe") return
          throw new Error("missing")
        },
        processRunning: () => false,
        execFile: async (file, args, options) => {
          calls.push({ file, args, timeout: options?.timeout })
          if (file === "powershell.exe") {
            installed = true
            return { stdout: "installed", stderr: "" }
          }
          if (args[0] === "status" && calls.length === 2) return { stdout: JSON.stringify({ running: false }), stderr: "" }
          if (args[0] === "start") return { stdout: "started", stderr: "" }
          return { stdout: JSON.stringify({ running: true, port: 10086 }), stderr: "" }
        },
      },
    })

    expect(calls).toEqual([
      {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "irm https://cdn.kimi.com/webbridge/install.ps1 | iex",
        ],
        timeout: 120_000,
      },
      {
        file: "C:\\Users\\zhangxiaohui\\.kimi-webbridge\\bin\\kimi-webbridge.exe",
        args: ["status"],
        timeout: undefined,
      },
      {
        file: "C:\\Users\\zhangxiaohui\\.kimi-webbridge\\bin\\kimi-webbridge.exe",
        args: ["start"],
        timeout: undefined,
      },
      {
        file: "C:\\Users\\zhangxiaohui\\.kimi-webbridge\\bin\\kimi-webbridge.exe",
        args: ["status"],
        timeout: undefined,
      },
    ])
  })

  test("installs on macOS when the executable is missing", async () => {
    let installed = false
    const calls: { file: string; args: string[]; timeout?: number }[] = []

    await ensureKimiWebBridgeDaemon({
      dependencies: {
        homeDir: "/Users/guochunzhong",
        platform: "darwin",
        readFile: async () => {
          throw new Error("missing")
        },
        access: async (path) => {
          if (installed && path === "/Users/guochunzhong/.kimi-webbridge/bin/kimi-webbridge") return
          throw new Error("missing")
        },
        processRunning: () => false,
        execFile: async (file, args, options) => {
          calls.push({ file, args, timeout: options?.timeout })
          if (file === "bash") {
            installed = true
            return { stdout: "installed", stderr: "" }
          }
          return { stdout: JSON.stringify({ running: true, port: 10086 }), stderr: "" }
        },
      },
    })

    expect(calls).toEqual([
      {
        file: "bash",
        args: ["-lc", "curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash"],
        timeout: 120_000,
      },
      {
        file: "/Users/guochunzhong/.kimi-webbridge/bin/kimi-webbridge",
        args: ["status"],
        timeout: undefined,
      },
    ])
  })

  test("does not start on unsupported platforms when command is missing", async () => {
    const calls: string[] = []

    await ensureKimiWebBridgeDaemon({
      dependencies: {
        homeDir: "/tmp/home",
        platform: "linux",
        readFile: async () => {
          throw new Error("missing")
        },
        access: async () => {
          throw new Error("missing")
        },
        processRunning: () => false,
        execFile: async (_file, args) => {
          calls.push(args.join(" "))
          return { stdout: "", stderr: "" }
        },
      },
    })

    expect(calls).toEqual([])
  })

  test("does not start when status fails but pid is active", async () => {
    const calls: string[] = []

    await ensureKimiWebBridgeDaemon({
      dependencies: {
        homeDir: "/tmp/home",
        readFile: async () => "123",
        access: async () => undefined,
        processRunning: () => true,
        execFile: async (_file, args) => {
          calls.push(args.join(" "))
          throw new Error("status failed")
        },
      },
    })

    expect(calls).toEqual(["status"])
  })
})
