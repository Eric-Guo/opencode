import { expect, test } from "bun:test"
import { loadConfigFromFile, RendererConfigFactory } from "electron-vite"
import { createServer } from "vite"
import { mkdtempDisposable } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { pickerPlugin } from "./picker"

test.each([true, false])(
  "serves browser-loadable picker scripts with bundled dev = %s",
  async (bundledDev) => {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      fileURLToPath(new URL("../electron.vite.config.ts", import.meta.url)),
    )

    if (!loaded.config.renderer) throw new Error("Missing renderer configuration")

    const config = await new RendererConfigFactory(
      loaded.config.renderer,
      { configFile: false, mode: "development" },
      { root: fileURLToPath(new URL("..", import.meta.url)) },
    ).build()

    const server = await createServer({
      ...config,
      configFile: false,
      root: fileURLToPath(new URL("./fixtures/picker", import.meta.url)),
      build: {
        ...config.build,
        rolldownOptions: { input: { main: fileURLToPath(new URL("./fixtures/picker/index.html", import.meta.url)) } },
      },
      experimental: { bundledDev },
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    })

    await server.listen()
    const url = server.resolvedUrls?.local[0]

    if (!url) throw new Error("Missing fixture server URL")

    const socket = bundledDev
      ? new WebSocket(`${url.replace("http:", "ws:")}?token=${server.config.webSocketToken}`, "vite-hmr")
      : undefined

    try {
      if (socket && !server.environments.client.bundledDev?.hasBuildOutput) {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("error", reject, { once: true })
          socket.addEventListener("message", (event) => {
            const message: { type: string } = JSON.parse(String(event.data))

            if (message.type === "full-reload") resolve()
          })
        })
      }

      for (const path of ["/", "/index.html", "/server/example/session/example", "/new-session?draftId=example"]) {
        const html = await fetch(new URL(path, url)).then((response) => response.text())
        const sources = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1])

        const scripts = await Promise.all(
          sources.map((source) => fetch(new URL(source, url)).then((response) => response.text())),
        )

        expect(scripts.length).toBeGreaterThan(0)

        if (bundledDev) expect(scripts.join("\n")).toContain("opencodePickerUi")
        expect([html, ...scripts].join("\n")).not.toMatch(/\bimport(?:\s*\(\s*|\s*)["']virtual:/)
      }

      const direct = await fetch(new URL("/__vite_opencode_picker_client.js", url))
      expect(direct.ok).toBe(true)
      expect(await direct.text()).toContain("opencodePickerUi")
    } finally {
      socket?.close()
      await server.close()
    }
  },
  30_000,
)

test("reads picker options from the authenticated desktop dev service", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "opencode-picker-"))
  const file = join(directory.path, "service-local.json")
  const model = { id: "fixture/model", providerID: "fixture", name: "Fixture model", enabled: true }
  const disabled = { ...model, id: "fixture/disabled", enabled: false }

  using service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Basic ${btoa("opencode:fixture-password")}`)
        return new Response(null, { status: 401 })

      const path = new URL(request.url).pathname

      if (path === "/api/info") return Response.json({ pid: process.pid, version: "fixture" })

      if (path === "/api/model") return Response.json({ data: [model, disabled] })

      if (path === "/api/model/default") return Response.json({ data: model })

      return new Response(null, { status: 404 })
    },
  })

  await Bun.write(file, JSON.stringify({ pid: process.pid, url: service.url, password: "fixture-password" }))

  const previous = process.env.OPENCODE_DESKTOP_PICKER_SERVICE_FILE
  process.env.OPENCODE_DESKTOP_PICKER_SERVICE_FILE = file

  try {
    const vite = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("./fixtures/picker", import.meta.url)),
      plugins: [pickerPlugin()],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    })

    try {
      await vite.listen()
      const url = vite.resolvedUrls?.local[0]

      if (!url) throw new Error("Missing fixture server URL")

      const response = await fetch(new URL("/__vite_opencode_picker?options=1", url))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        defaultModel: "Fixture model",
        models: [{ id: "fixture/model", providerID: "fixture", name: "Fixture model" }],
      })
    } finally {
      await vite.close()
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DESKTOP_PICKER_SERVICE_FILE
    else process.env.OPENCODE_DESKTOP_PICKER_SERVICE_FILE = previous
  }
})
