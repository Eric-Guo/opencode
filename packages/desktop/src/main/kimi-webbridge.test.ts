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
