import { lookup } from "node:dns/promises"
import http, { type IncomingMessage } from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import { isUtf8 } from "node:buffer"
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib"
import { TextDecoder } from "node:util"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { scheduler } from "node:timers/promises"
import ipaddr from "ipaddr.js"
import { Schema } from "effect"
import { Configuration, type ExtensionDescriptor } from "./configuration"
import type { CommitTask } from "@cybros/agent"
import type { RunnerContext } from "./extensions"
import { outputHead } from "./output-window"

const CAP = 5 * 1024 * 1024
const ACTIONABLE_URL_BYTES = 8190
const INVISIBLE = /[\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
export const webDescriptor: ExtensionDescriptor = {
  id: "nexus.web-tools",
  name: "Web reader",
  description: "Read HTTP(S) pages, with bounded responses and same-site redirects.",
  default_enabled: true,
  configuration_version: 1,
  configuration_schema: {
    type: "object",
    properties: { allow_private_network: { type: "boolean" } },
    additionalProperties: false,
  },
  defaults: { allow_private_network: false },
}

export type WebOptions = {
  allowPrivateNetwork?: boolean
  totalTimeout?: number
  connectTimeout?: number
  artifacts?: string
  raw?: boolean
}

export function webSite(value: unknown) {
  if (typeof value !== "string" || !URL.canParse(value)) throw new Error("Expected an HTTP(S) URL.")
  const match = /^(https?:\/\/[^/?#]+)(?:[/?#]|$)/i.exec(value)
  if (!match || /[\s\\]/.test(value) || /[@*|]/.test(match[1])) throw new Error("Expected a literal HTTP(S) site.")
  return match[1]
}

/** The operator reads from the CLI machine, including when its managed service is offline. */
export async function operatorWebFetch(url: string, storage: string, raw: boolean, signal: AbortSignal) {
  const settings = new Configuration(join(storage, "configuration.json"))
  await settings.restore()
  const selection = settings.selection(webDescriptor)
  if (!selection.enabled) throw new Error("The Nexus web reader is disabled.")

  const result = await webFetch(url, signal, undefined, {
    allowPrivateNetwork: selection.configuration.allow_private_network === true,
    raw: true,
  })
  if (result.is_error) throw new Error(String(result.content))

  const metadata = Schema.decodeUnknownSync(
    Schema.Struct({ status_line: Schema.String, encoding: Schema.Literals(["base64", "utf8"]) }),
  )(result.structured_content)
  const content = Schema.decodeUnknownSync(Schema.String)(result.content)
  const body =
    metadata.encoding === "base64"
      ? Buffer.from(content, "base64")
      : raw
        ? content
        : content.replace(INVISIBLE, (char) => "\\u{" + char.codePointAt(0)!.toString(16).toUpperCase() + "}")
  return { status: metadata.status_line, body }
}

function webURL(value: string) {
  const site = webSite(value)
  const authority = site.slice(site.indexOf("://") + 3)
  const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0]
  const url = new URL(value)

  if (/[^\x21-\x7e]/.test(value) || !/^https?:\/\//.test(value))
    throw new Error("Use an ASCII HTTP(S) URL; percent-encode non-ASCII path and query characters.")
  if (host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6) return url
  if (!host || host !== url.hostname || host !== host.toLowerCase() || host.endsWith(".") || host.includes("%"))
    throw new Error("Use a canonical lowercase host, without a trailing dot, and four dotted decimals for IPv4.")
  return url
}

function publicAddress(address: string, allowPrivateNetwork: boolean) {
  const ip = ipaddr.parse(address)
  if (allowPrivateNetwork && (ip.range() === "loopback" || (ip.kind() === "ipv4" && ip.range() === "private")))
    return true
  return ip.range() === "unicast" && (ip.kind() === "ipv4" || ip.toByteArray()[0] >> 5 === 1)
}

export async function webFetch(
  input: string,
  signal: AbortSignal,
  publish: RunnerContext["publish"],
  options: WebOptions = {},
): Promise<Omit<CommitTask, "claim_token">> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(options.totalTimeout ?? 30000)])
  const details = {
    url: input,
    final_url: null as string | null,
    status: null as number | null,
    content_type: null as string | null,
    bytes: 0,
    truncation: null,
  }

  try {
    active.throwIfAborted()
    const initial = webURL(input)
    let url = initial

    for (let hop = 0; hop <= 3; hop++) {
      active.throwIfAborted()
      const hostname = url.hostname.replace(/^\[|\]$/g, "")
      const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const abort = () => reject(active.reason)
        active.addEventListener("abort", abort, { once: true })
        const resolving = isIP(hostname)
          ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
          : lookup(hostname, { all: true })

        void resolving.then(resolve, reject).finally(() => active.removeEventListener("abort", abort))
      })
      active.throwIfAborted()
      if (
        !addresses.length ||
        addresses.some((item) => !publicAddress(item.address, options.allowPrivateNetwork === true))
      ) {
        const reason = !addresses.length
          ? "No IP addresses were returned for this host."
          : "Web fetch requires a public address; this host resolves to a private or reserved address."
        const hint =
          !isIP(hostname) && addresses.length
            ? " If this is a public site on a proxy or VPN, try browser_navigate with the Browser extension."
            : ""

        return {
          is_error: true,
          content: reason + hint,
          structured_content: { ...details, error_code: addresses.length ? "address_blocked" : "dns_no_addresses" },
        }
      }

      // Connect to the checked IP while preserving the HTTP authority and TLS identity.
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(
          url,
          {
            hostname: addresses[0].address,
            servername: isIP(hostname) ? undefined : hostname,
            agent: false,
            maxHeaderSize: 1024 * 1024,
            signal: active,
            headers: {
              Host: url.host,
              "User-Agent": "OpenCode-Nexus/1.0",
              Accept: "text/markdown, text/html, */*",
              "Accept-Encoding": "gzip, deflate, br",
            },
          },
          resolve,
        )
        const timer = setTimeout(
          () => request.destroy(new Error("Web server did not accept a connection in time.")),
          options.connectTimeout ?? 10000,
        )

        request.once("socket", (socket) =>
          socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(timer)),
        )
        request.once("close", () => clearTimeout(timer))
        request.once("error", reject)
        request.end()
      })

      try {
        const status = response.statusCode ?? 0
        Object.assign(details, {
          final_url: url.href,
          status,
          content_type: (response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
        })

        if (status >= 300 && status < 400 && response.headers.location) {
          const location = response.headers.location
          if (!URL.canParse(location, url.href) || /[^\x21-\x7e]/.test(location) || /\\/.test(location)) {
            details.final_url = null
            return {
              is_error: true,
              content: `The server returned a malformed redirect Location: ${shorten(JSON.stringify(location), 512)}`,
              structured_content: details,
            }
          }
          const next = new URL(
            /^https?:\/\//i.test(location)
              ? location
              : location.startsWith("//")
                ? url.protocol + location
                : new URL(location, url).href,
          )
          const same =
            !next.username &&
            !next.password &&
            next.protocol === initial.protocol &&
            next.port === initial.port &&
            next.hostname.replace(/^www\./, "") === initial.hostname.replace(/^www\./, "")

          if (!same || hop === 3) {
            details.final_url = Buffer.byteLength(next.href) <= ACTIONABLE_URL_BYTES ? next.href : null
            return {
              is_error: true,
              content: same
                ? "Too many redirects (maximum 3)."
                : details.final_url
                  ? "Redirect to another site. Request this URL separately: " + details.final_url
                  : "Redirect to another site. The target URL is too long: " + shorten(next.href, ACTIONABLE_URL_BYTES),
              structured_content: details,
            }
          }
          const retry = response.headers["retry-after"]
          if (retry !== undefined) {
            const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
            if (!Number.isFinite(delay)) {
              details.status = null
              details.final_url = Buffer.byteLength(next.href) <= ACTIONABLE_URL_BYTES ? next.href : null
              return {
                is_error: true,
                content: details.final_url
                  ? "The server's Retry-After is not a number of seconds or an HTTP date. Request this URL separately: " +
                    details.final_url
                  : "The server's Retry-After is not a number of seconds or an HTTP date. The target URL is too long: " +
                    shorten(next.href, ACTIONABLE_URL_BYTES),
                structured_content: details,
              }
            }
            if (delay > 0) await scheduler.wait(Math.min(delay, 2147483647), { signal: active })
          }
          webURL(next.href)
          url = next
          continue
        }
        if (Number(response.headers["content-length"]) > CAP) throw new WebTooLarge(0)
        const chunks: Buffer[] = []
        let size = 0

        for await (const chunk of response) {
          active.throwIfAborted()
          const data = Buffer.from(chunk)
          size += data.length
          if (size > CAP) throw new WebTooLarge(size)
          chunks.push(data)
        }
        const encoded = Buffer.concat(chunks)
        const encoding = response.headers["content-encoding"]?.toLowerCase()
        const bytes =
          encoding === "gzip"
            ? gunzipSync(encoded, { maxOutputLength: CAP })
            : encoding === "deflate"
              ? inflateSync(encoded, { maxOutputLength: CAP })
              : encoding === "br"
                ? brotliDecompressSync(encoded, { maxOutputLength: CAP })
                : encoded
        details.bytes = bytes.length
        active.throwIfAborted()

        const challenge = response.headers["cf-mitigated"] === "challenge"
        if (status < 200 || status >= 300 || challenge) {
          const phrase = http.STATUS_CODES[status]
          const heading = shorten(initial.href, 512) + " answered " + status + (phrase ? " " + phrase : "")
          const excerpt = challenge
            ? ""
            : decode(status >= 400 ? bytes.subarray(0, 512) : bytes, response.headers["content-type"] ?? "", false).trim()
          const hint = challenge
            ? "The site returned a browser verification page. Open the page with browser_navigate and report any verification the site requires."
            : ""

          return {
            is_error: true,
            content: [heading, hint, excerpt].filter(Boolean).join("\n\n"),
            structured_content: { ...details, ...(challenge ? { error_code: "browser_challenge" } : {}) },
          }
        }

        const rendered = await renderWebContent(bytes, response.headers["content-type"] ?? "", publish, {
          ...options,
          url: url.href,
        })
        const heading = `${shorten(url.href, 512)} — ${status} ${details.content_type}; ${formatSize(bytes.length)} fetched${rendered.rendered_bytes ? `, rendered the first ${formatSize(rendered.rendered_bytes)} of ${formatSize(bytes.length)}` : ""}${rendered.markdown_bytes !== undefined ? `, ${formatSize(rendered.markdown_bytes)} markdown` : ""}${hop ? ` (${hop} redirect${hop === 1 ? "" : "s"})` : ""}${rendered.title ? `; title: ${shorten(rendered.title, 256)}` : ""}`

        return {
          ...(rendered.is_error ? { is_error: true } : {}),
          content:
            typeof rendered.content === "string"
              ? (options.raw ? "" : heading + "\n\n") + rendered.content
              : [
                  ...(options.raw ? [] : [{ type: "text", text: heading }]),
                  ...(Array.isArray(rendered.content) ? rendered.content : []),
                ],
          structured_content: {
            ...details,
            ...(options.raw
              ? {
                  status_line:
                    rendered.encoding === "base64"
                      ? `${shorten(url.href, 512)} — ${status} ${details.content_type}; ${formatSize(bytes.length)}`
                      : heading,
                  encoding: rendered.encoding ?? "utf8",
                }
              : {}),
            ...(rendered.structured_content &&
            typeof rendered.structured_content === "object" &&
            !Array.isArray(rendered.structured_content)
              ? rendered.structured_content
              : {}),
          },
        }
      } finally {
        response.destroy()
      }
    }
    throw new Error("Too many redirects.")
  } catch (error) {
    signal.throwIfAborted()
    const tooLarge = error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE"
    return {
      is_error: true,
      content: active.aborted
        ? "Web fetch exceeded its total deadline."
        : tooLarge
          ? "Response exceeds 5 MiB."
          : error instanceof Error
            ? error.message
            : "Web fetch failed.",
      structured_content: {
        url: input,
        final_url: null,
        status: null,
        content_type: null,
        bytes: error instanceof WebTooLarge ? error.bytes : tooLarge ? CAP + 1 : 0,
        truncation: null,
      },
    }
  }
}

class WebTooLarge extends Error {
  constructor(readonly bytes: number) {
    super("Response exceeds 5 MiB.")
  }
}

export async function renderWebContent(
  bytes: Buffer<ArrayBuffer>,
  contentType: string,
  publish: RunnerContext["publish"],
  options: { artifacts?: string; url?: string; raw?: boolean } = {},
): Promise<
  Omit<CommitTask, "claim_token"> & {
    title?: string
    markdown_bytes?: number
    rendered_bytes?: number
    encoding?: "base64"
  }
> {
  const type = contentType.split(";")[0].trim().toLowerCase()
  const html = type === "text/html" || type === "application/xhtml+xml"
  if (!html && !type.startsWith("text/") && !/(?:[/+](?:json|xml)|\/javascript)$/.test(type)) {
    if (options.raw) return { content: bytes.toString("base64"), encoding: "base64" }
    const own = options.url ? extname(new URL(options.url).pathname).toLowerCase() : ""
    const subtype = type.split("/").at(-1) ?? ""
    const extension = /^\.[a-z0-9]{1,8}$/.test(own)
      ? own
      : ["png", "jpeg", "gif", "webp", "bmp"].includes(subtype)
        ? "." + subtype
        : ".bin"
    const name = "web-" + createHash("sha256").update(bytes).digest("hex").slice(0, 16) + extension
    if (!publish) throw new Error("Web capture requires an upload context.")
    const path = await capture(bytes, name, options.artifacts)
    const file = await publish(new Blob([bytes], { type: type || "application/octet-stream" }), name)
    return { content: [{ type: "text", text: `${formatSize(bytes.length)} saved to ${path ?? name}` }, file] }
  }

  const body = decode(html ? bytes.subarray(0, 1048576) : bytes, contentType, html)
  const rendered = html ? await markdown(body, options.url ? new URL(options.url) : undefined) : { text: body }
  const text = rendered.text.replace(INVISIBLE, "")
  const metadata = {
    ...(rendered.title ? { title: rendered.title } : {}),
    ...(html ? { markdown_bytes: Buffer.byteLength(text) } : {}),
    ...(html && bytes.length > 1048576 ? { rendered_bytes: 1048576 } : {}),
  }

  const output = options.raw ? { text, truncation: null } : outputHead(text)
  const limits = output.truncation
  const details = { truncation: limits }
  if (!limits) return { content: output.text, structured_content: details, ...metadata }

  const name = "web-" + createHash("sha256").update(text).digest("hex").slice(0, 16) + ".md"
  if (!publish) throw new Error("Web capture requires an upload context.")
  const path = await capture(Buffer.from(text), name, options.artifacts)
  const file = await publish(new Blob([text], { type: html ? "text/markdown" : type }), name)
  const footer = limits.first_line_exceeds_limit
    ? `[Line 1 is ${formatSize(limits.total_bytes)}, exceeds 50.0KB limit. Full output: ${path ?? name}]`
    : `\n\n[Showing lines 1-${limits.output_lines} of ${limits.total_lines}${limits.truncated_by === "bytes" ? " (50.0KB limit)" : ""}. Full output: ${path ?? name}]`
  return { content: [{ type: "text", text: output.text + footer }, file], structured_content: details, ...metadata }
}

async function markdown(body: string, url?: URL) {
  const { convertHTMLToMarkdown } = await import("@opencode/core/tool/html-markdown")
  const { Parser } = await import("htmlparser2")
  const omitted = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed"])
  const parts: string[] = []
  let depth = 0
  let start = 0
  let title: string | undefined
  let base: string | undefined
  let readingTitle = false
  const parser = new Parser({
    onopentag(name, attributes) {
      if (depth) {
        depth++
        return
      }
      if (name === "base" && base === undefined) base = attributes.href
      if (name !== "title" && !omitted.has(name)) return

      parts.push(body.slice(start, parser.startIndex))
      depth = 1
      readingTitle = name === "title" && title === undefined
      if (readingTitle) title = ""
    },
    ontext(text) {
      if (readingTitle) title += text
    },
    onclosetag() {
      if (!depth) return
      depth--
      if (depth) return
      start = parser.endIndex + 1
      readingTitle = false
    },
  })
  parser.end(body)
  parts.push(body.slice(start))
  const heading = title?.replace(INVISIBLE, "").trim()
  const resolved = url && base !== undefined ? URL.parse(base, url.href) : undefined
  const baseURL = resolved && /^(?:http|https):$/.test(resolved.protocol) ? resolved : url

  return { text: convertHTMLToMarkdown(parts.join(""), baseURL), ...(heading ? { title: heading } : {}) }
}

async function capture(bytes: Buffer, name: string, directory?: string) {
  if (!directory) return
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, name)
  await writeFile(path, bytes, { mode: 0o600 })
  return path
}

function formatSize(bytes: number) {
  return bytes < 1024
    ? bytes + "B"
    : bytes < 1048576
      ? (bytes / 1024).toFixed(1) + "KB"
      : (bytes / 1048576).toFixed(1) + "MB"
}

function decode(bytes: Uint8Array, contentType: string, html: boolean) {
  const bom =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? "utf-8"
          : undefined
  const declared = /;\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]
  const meta = html
    ? /<meta[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(
        Buffer.from(bytes.subarray(0, 1024)).toString("latin1"),
      )?.[1]
    : undefined
  const utf8 =
    isUtf8(bytes) ||
    [1, 2, 3].some((length) => {
      if (bytes.length < length || !isUtf8(bytes.subarray(0, bytes.length - length))) return false
      const tail = bytes.subarray(bytes.length - length)
      const expected =
        tail[0] >= 0xc2 && tail[0] <= 0xdf
          ? 2
          : tail[0] >= 0xe0 && tail[0] <= 0xef
            ? 3
            : tail[0] >= 0xf0 && tail[0] <= 0xf4
              ? 4
              : 0
      return expected > length && tail.subarray(1).every((byte) => (byte & 0xc0) === 0x80)
    })
  const labels = [bom, declared, meta, html && !utf8 ? "windows-1252" : "utf-8"].filter((label) => label !== undefined)

  for (const label of labels) {
    try {
      return new TextDecoder(label).decode(bytes).replace(INVISIBLE, "")
    } catch {
      // Unknown HTTP/meta charset labels fall through to the next encoding source.
    }
  }
  return new TextDecoder().decode(bytes).replace(INVISIBLE, "")
}

function shorten(value: string, bytes: number) {
  const line = value.replace(/[\r\n\t]/g, " ").replace(INVISIBLE, "")
  const encoded = Buffer.from(line)
  if (encoded.length <= bytes) return line
  const marker = (omitted: number) => " …(" + omitted + " more bytes)"
  const kept = new TextDecoder().decode(encoded.subarray(0, bytes - Buffer.byteLength(marker(encoded.length))), {
    stream: true,
  })
  return kept + marker(encoded.length - Buffer.byteLength(kept))
}
