import { expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Configuration } from "../src/configuration"
import { operatorWebFetch, webDescriptor, webFetch, renderWebContent } from "../src/web"
import { tmpdir } from "../../core/test/fixture/tmpdir"

test("web fetch follows bounded same-site redirects, decodes compressed bodies and preserves HTTP errors", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === "/redirect") return new Response(null, { status: 302, headers: { Location: "/page" } })
      if (path === "/moved") return new Response(null, { status: 302, headers: { Location: "/news/index.html" } })
      if (path === "/news/index.html")
        return new Response('<a href="first">First</a><a href="/today">Today</a>', {
          headers: { "Content-Type": "text/html" },
        })
      if (path === "/challenge")
        return new Response("<h1>Verify</h1>", { status: 403, headers: { "cf-mitigated": "challenge" } })
      if (path === "/titles")
        return new Response(
          "<template><title>Hidden</title></template><title>Quarterly &amp; annual</title>" +
            "<svg><title>Chart</title></svg><title>Duplicate</title><p>Sales</p>",
          { headers: { "Content-Type": "text/html" } },
        )
      if (path === "/other")
        return new Response(null, { status: 302, headers: { Location: "https://example.com/private" } })
      if (path === "/loop") return new Response(null, { status: 302, headers: { Location: "/loop" } })
      if (path === "/error") return new Response("denied\n" + "x".repeat(1000), { status: 403 })
      if (path === "/missing") return Response.redirect(new URL("/empty", request.url).href)
      if (path === "/empty") return new Response("  \n", { status: 404 })
      if (path === "/choices") return new Response("  " + "ä".repeat(300) + "\n", { status: 300 })
      if (path === "/bomb")
        return new Response(gzipSync("x".repeat(5 * 1024 * 1024 + 1)), { headers: { "Content-Encoding": "gzip" } })
      if (path === "/large") return new Response("x".repeat(6 * 1024 * 1024))
      return new Response(gzipSync(Buffer.from('<meta charset="windows-1252"><h1>caf\xe9</h1>', "latin1")), {
        headers: { "Content-Encoding": "gzip", "Content-Type": "text/html" },
      })
    },
  })
  const signal = new AbortController().signal
  const publish = async () => {
    throw new Error("Unexpected attachment")
  }
  const options = { allowPrivateNetwork: true }

  try {
    const page = await webFetch(new URL("/redirect", server.url).href, signal, publish, options)
    expect(page.content).toContain("(1 redirect)")
    expect(page.content).toContain("# café")
    expect(page.structured_content).toMatchObject({ status: 200, final_url: new URL("/page", server.url).href })
    expect(requests).toEqual(["/redirect", "/page"])

    const moved = await webFetch(new URL("/moved", server.url).href, signal, publish, options)
    expect(moved.content).toContain(`[First](${new URL("/news/first", server.url).href})`)
    expect(moved.content).toContain(`[Today](${new URL("/today", server.url).href})`)

    const challenge = await webFetch(new URL("/challenge", server.url).href, signal, publish, options)
    expect(challenge).toMatchObject({
      is_error: true,
      content: expect.stringContaining("browser_navigate"),
      structured_content: { status: 403, error_code: "browser_challenge" },
    })

    const titles = await webFetch(new URL("/titles", server.url).href, signal, publish, options)
    expect(titles.content).toEndWith("; title: Quarterly & annual\n\nSales")

    const other = await webFetch(new URL("/other", server.url).href, signal, publish, options)
    expect(other).toMatchObject({
      is_error: true,
      structured_content: { final_url: "https://example.com/private", status: 302 },
    })
    const loop = await webFetch(new URL("/loop", server.url).href, signal, publish, options)
    expect(loop).toMatchObject({ is_error: true, content: expect.stringContaining("maximum 3") })
    expect(requests.filter((path) => path === "/loop")).toHaveLength(4)

    const failure = await webFetch(new URL("/error", server.url).href, signal, publish, options)
    expect(failure).toMatchObject({
      is_error: true,
      content: expect.stringContaining(" answered 403 Forbidden\n\ndenied"),
      structured_content: { status: 403, bytes: 1007 },
    })
    expect(String(failure.content).length).toBeLessThan(650)
    const missing = new URL("/missing", server.url).href
    expect(await webFetch(missing, signal, publish, options)).toMatchObject({
      content: missing + " answered 404 Not Found",
      structured_content: { status: 404, final_url: new URL("/empty", server.url).href },
    })
    const choices = new URL("/choices", server.url).href
    expect(await webFetch(choices, signal, publish, options)).toMatchObject({
      content: choices + " answered 300 Multiple Choices\n\n" + "ä".repeat(300),
    })
    expect(await webFetch(new URL("/bomb", server.url).href, signal, publish, options)).toMatchObject({
      is_error: true,
      structured_content: { status: null, final_url: null, content_type: null, bytes: 5 * 1024 * 1024 + 1 },
    })
    expect(await webFetch(new URL("/large", server.url).href, signal, publish, options)).toMatchObject({
      is_error: true,
      structured_content: { status: null, final_url: null, content_type: null, bytes: 0 },
    })
  } finally {
    server.stop(true)
  }
})

test("web cancellation interrupts response-body waits and canonical URL refusals open no sockets", async () => {
  const received = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      received.resolve()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"))
          },
        }),
      )
    },
  })
  const owner = new AbortController()
  const publish = async () => {
    throw new Error("Unexpected attachment")
  }

  try {
    const pending = webFetch(server.url.href, owner.signal, publish, { allowPrivateNetwork: true })
    await received.promise
    owner.abort(new Error("stop reading"))
    await expect(pending).rejects.toThrow("stop reading")

    for (const url of [
      "http://LOCALHOST/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://example.com./",
      "http://ex%61mple.com/",
    ])
      expect(await webFetch(url, new AbortController().signal, publish)).toMatchObject({
        is_error: true,
        content: expect.stringContaining("canonical"),
      })
  } finally {
    server.stop(true)
  }
})

test("web rendering detects legacy encodings, strips invisible controls and caps UTF-8 bytes and lines", async () => {
  const uploaded: Blob[] = []
  const publish = async (blob: Blob) => {
    uploaded.push(blob)
    return { type: "resource_link", uri: "nexus://uploads/full", name: "full" }
  }
  const html = Buffer.from('<meta charset="windows-1252"><h1>caf\xe9</h1><script>secret</script>', "latin1")

  expect((await renderWebContent(html, "text/html", publish)).content).toBe("# café")
  expect((await renderWebContent(Buffer.from("one\u202etwo\0three"), "text/plain", publish)).content).toBe(
    "onetwothree",
  )
  const exact = "界".repeat(17066) + "ab"
  const withNewline = Buffer.from(exact + "\n")
  expect(await renderWebContent(withNewline, "text/plain", publish)).toEqual({
    content: exact,
    structured_content: { truncation: null },
  })
  expect((await renderWebContent(withNewline, "text/plain", publish, { raw: true })).content).toBe(exact + "\n")
  expect(uploaded).toEqual([])

  const unicode = "界".repeat(30000)
  const rendered = await renderWebContent(Buffer.from(unicode), "text/plain", publish)

  expect(Array.isArray(rendered.content)).toBe(true)
  if (!Array.isArray(rendered.content)) throw new Error("Expected attachment blocks")
  const text = rendered.content[0]
  if (!text || typeof text !== "object" || Array.isArray(text) || typeof text.text !== "string")
    throw new Error("Expected text block")
  expect(text.text).toContain("Line 1 is 87.9KB, exceeds 50.0KB limit")
  expect(text.text).not.toContain("界")
  expect(text.text).not.toContain("�")
  expect(await uploaded[0].text()).toBe(unicode)

  const lines = await renderWebContent(Buffer.from("line\n".repeat(2001)), "text/plain", publish)
  expect(lines.structured_content).toMatchObject({ truncation: { total_lines: 2001, max_lines: 2000 } })
})

test("web captures are content-addressed readable files and preserve whole lines", async () => {
  await using directory = await tmpdir()
  const names: string[] = []
  const publish = async (_blob: Blob, name: string) => {
    names.push(name)
    return { type: "resource_link", uri: "nexus://uploads/" + name, name }
  }
  const text = "kept\n" + "界".repeat(20000) + "\nlast"
  const first = await renderWebContent(Buffer.from(text), "text/plain", publish, { artifacts: directory.path })
  const second = await renderWebContent(Buffer.from(text), "text/plain", publish, { artifacts: directory.path })
  expect(first).toEqual(second)
  expect(first.structured_content).toMatchObject({ truncation: { output_lines: 1, output_bytes: 4, max_bytes: 51200 } })
  expect(first.content).toEqual([
    {
      type: "text",
      text: expect.stringContaining(`kept\n\n[Showing lines 1-1 of 3 (50.0KB limit). Full output: ${directory.path}`),
    },
    { type: "resource_link", uri: "nexus://uploads/" + names[0], name: names[0] },
  ])
  expect(await readFile(directory.path + "/" + names[0], "utf8")).toBe(text)
  expect(await readdir(directory.path)).toEqual([names[0]])

  const binary = Buffer.from([0, 255, 10, 127])
  await renderWebContent(binary, "image/png", publish, { artifacts: directory.path, url: "https://example.com/image" })
  expect(names[2]).toEndWith(".png")
  expect(await readFile(directory.path + "/" + names[2])).toEqual(binary)
  expect((await renderWebContent(Buffer.from(text), "text/plain", publish, { raw: true })).content).toBe(text)
})

test("HTML metadata and clipped multibyte tails survive rendering without hidden SVG content", async () => {
  const publish = async () => ({ type: "resource_link", uri: "nexus://uploads/page", name: "page" })
  const page = await renderWebContent(
    Buffer.from("<title>One &amp; two</title><p>visible</p><svg><text>hidden</text><svg>also hidden</svg></svg>"),
    "text/html",
    publish,
  )
  expect(page).toMatchObject({ title: "One & two", content: "visible" })
  const links = await renderWebContent(
    Buffer.from(
      '<template><base href="/ignored/"></template><a href="topic/42#reply">Topic</a><base href="/discussion/">',
    ),
    "text/html",
    publish,
    { url: "https://example.test/home/" },
  )
  expect(links.content).toBe("[Topic](https://example.test/discussion/topic/42#reply)")
  const start = "<p>café</p>"
  const bytes = Buffer.from(start + " ".repeat(1048576 - Buffer.byteLength(start) - 1) + "界</p>")
  const cut = await renderWebContent(bytes, "text/html", publish)
  expect(cut).toMatchObject({ rendered_bytes: 1048576 })
  expect(JSON.stringify(cut.content)).toContain("café")
  expect(JSON.stringify(cut.content)).not.toContain("cafÃ")
})

test("redirect refusals preserve actionable destinations without following malformed headers", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path.startsWith("/hop/")) {
        const hop = Number(path.split("/").at(-1))
        return new Response(null, {
          status: 302,
          headers: { Location: hop === 3 ? "https://example.org/next" : "/hop/" + (hop + 1) },
        })
      }
      if (path === "/bad") return new Response(null, { status: 302, headers: { Location: "/has a space" } })
      if (path === "/retry")
        return new Response(null, { status: 302, headers: { Location: "/next", "Retry-After": "later" } })
      if (path === "/huge")
        return new Response(null, { status: 302, headers: { Location: "https://example.org/" + "x".repeat(60000) } })
      if (path === "/zero")
        return new Response(null, { status: 302, headers: { Location: "/next", "Retry-After": "0" } })
      return new Response("done", { headers: { "Content-Type": "text/plain" } })
    },
  })
  const publish = async () => {
    throw new Error("Unexpected attachment")
  }
  const fetch = (path: string, raw = false) =>
    webFetch(new URL(path, server.url).href, new AbortController().signal, publish, { allowPrivateNetwork: true, raw })
  try {
    expect(await fetch("/bad")).toMatchObject({ is_error: true, structured_content: { status: 302, final_url: null } })
    expect(await fetch("/retry")).toMatchObject({
      is_error: true,
      structured_content: { status: null, final_url: new URL("/next", server.url).href },
    })
    const huge = await fetch("/huge")
    expect(huge).toMatchObject({ is_error: true, structured_content: { status: 302, final_url: null } })
    expect(String(huge.content)).toMatch(/…\(\d+ more bytes\)$/)
    expect(await fetch("/hop/0")).toMatchObject({
      is_error: true,
      content: expect.stringContaining("Request this URL separately: https://example.org/next"),
      structured_content: { status: 302, final_url: "https://example.org/next" },
    })
    expect(await fetch("/hop/0", true)).toMatchObject({
      is_error: true,
      content: expect.stringContaining("Request this URL separately: https://example.org/next"),
    })
    expect(await fetch("/zero")).toMatchObject({ content: expect.stringContaining("done") })
    expect(requests).toEqual([
      "/bad",
      "/retry",
      "/huge",
      "/hop/0",
      "/hop/1",
      "/hop/2",
      "/hop/3",
      "/hop/0",
      "/hop/1",
      "/hop/2",
      "/hop/3",
      "/zero",
      "/next",
    ])
  } finally {
    server.stop(true)
  }
})

test("offline operator reads its installed web configuration and returns the whole rendering or binary bytes", async () => {
  await using directory = await tmpdir()
  const text = "read this line\n".repeat(6000)
  const bytes = Uint8Array.from([0, 255, 10, 127])
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/binary")
        return new Response(bytes, { headers: { "Content-Type": "image/png" } })
      return new Response(text, { headers: { "Content-Type": "text/plain" } })
    },
  })
  const settings = new Configuration(join(directory.path, "configuration.json"))
  const read = (path: string, raw: boolean) =>
    operatorWebFetch(new URL(path, server.url).href, directory.path, raw, AbortSignal.timeout(5000))
  await expect(read("/", false)).rejects.toThrow("private or reserved address")
  await settings.replace(webDescriptor, { enabled: true, configuration: { allow_private_network: true } })
  expect(await read("/", true)).toMatchObject({ body: text, status: expect.stringContaining("200 text/plain") })
  expect(await read("/binary", false)).toEqual({
    body: Buffer.from(bytes),
    status: new URL("/binary", server.url).href + " — 200 image/png; 4B",
  })
  expect((await read("/", false)).body).toBe(text)
  await settings.replace(webDescriptor, { enabled: false, configuration: { allow_private_network: true } })
  await expect(read("/", true)).rejects.toThrow("disabled")
})
