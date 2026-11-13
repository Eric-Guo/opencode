import { lookup } from "node:dns/promises"
import http, { type IncomingMessage } from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import { TextDecoder } from "node:util"
import ipaddr from "ipaddr.js"
import type { CommitTask } from "@cybros/agent"
import type { RunnerContext } from "./extensions"

export function webSite(value: unknown) {
  if (typeof value !== "string" || !URL.canParse(value)) throw new Error("Expected an HTTP(S) URL.")
  const match = /^(https?:\/\/[^/?#]+)(?:[/?#]|$)/i.exec(value)
  if (!match || /[\s\\]/.test(value) || /[@*|]/.test(match[1])) throw new Error("Expected a literal HTTP(S) site.")
  return match[1]
}

function publicAddress(address: string) {
  const ip = ipaddr.parse(address)
  return ip.range() === "unicast" && (ip.kind() === "ipv4" || ip.toByteArray()[0] >> 5 === 1)
}

export async function webFetch(input: string, signal: AbortSignal, publish: NonNullable<RunnerContext["publish"]>) {
  webSite(input)
  const initial = new URL(input)
  let url = initial
  for (let hop = 0; hop <= 3; hop++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true })
    if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
      throw new Error("Web fetch requires a public address.")
    // Connect to the checked IP while preserving the HTTP authority and TLS identity.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(
        url,
        {
          hostname: addresses[0].address,
          servername: isIP(hostname) ? undefined : hostname,
          agent: false,
          signal,
          headers: {
            Host: url.host,
            "User-Agent": "OpenCode-Nexus/1.0",
            Accept: "text/*,application/json,application/xml",
          },
        },
        resolve,
      )
      request.on("error", reject)
      request.end()
    })
    try {
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        const next = new URL(response.headers.location, url)
        webSite(next.href)
        if (next.origin !== initial.origin)
          return { is_error: true, content: "Redirect to another site. Request this URL separately: " + next.href }
        url = next
        continue
      }
      if (status < 200 || status >= 300) throw new Error("Web server returned HTTP " + status)
      const bytes: Buffer[] = []
      let size = 0
      for await (const chunk of response) {
        const data = Buffer.from(chunk)
        size += data.length
        if (size > 5 * 1024 * 1024) throw new Error("Response exceeds 5 MiB.")
        bytes.push(data)
      }
      return renderWebContent(Buffer.concat(bytes), response.headers["content-type"] ?? "", publish)
    } finally {
      response.destroy()
    }
  }
  throw new Error("Too many redirects.")
}

export async function renderWebContent(
  bytes: Buffer<ArrayBuffer>,
  contentType: string,
  publish: NonNullable<RunnerContext["publish"]>,
): Promise<Omit<CommitTask, "claim_token">> {
  const type = contentType.split(";")[0].trim().toLowerCase()
  const html = type === "text/html" || type === "application/xhtml+xml"
  if (!html && !type.startsWith("text/") && !/(?:[/+](?:json|xml)|\/javascript)$/.test(type)) {
    const file = await publish(new Blob([bytes], { type: type || "application/octet-stream" }), "web-response.bin")
    return { content: [file] }
  }

  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] ?? "utf-8"
  const body = new TextDecoder(charset).decode(bytes)
  let text = body
  if (html) {
    const { convertHTMLToMarkdown } = await import("@opencode/core/tool/html-markdown")
    text = convertHTMLToMarkdown(body)
  }
  if (text.length <= 65536) return { content: text }

  const file = await publish(
    new Blob([text], { type: html ? "text/markdown" : type }),
    html ? "web-response.md" : "web-response.txt",
  )
  return { content: [{ type: "text", text: text.slice(0, 65536) }, file] }
}
