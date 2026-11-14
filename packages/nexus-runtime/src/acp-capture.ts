import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk"

export class AcpCapture {
  private writing = Promise.resolve()
  private bytes = 0
  private truncated = false

  constructor(
    readonly path: string | null,
    private readonly secrets: readonly string[],
  ) {}

  redact(value: string) {
    return this.secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
  }

  record(direction: "in" | "out" | "note", message: unknown) {
    if (this.truncated || !this.path) return
    const line =
      JSON.stringify({ at: new Date().toISOString(), direction, message }, (_, value: unknown) =>
        typeof value === "string" ? this.redact(value) : value,
      ) + "\n"
    this.bytes += Buffer.byteLength(line)
    if (this.bytes > 16 * 1024 * 1024 - 1024) {
      this.truncated = true
      this.append(
        JSON.stringify({
          at: new Date().toISOString(),
          direction: "note",
          message: "Transcript reached its 16 MiB limit.",
        }) + "\n",
      )
      return
    }
    this.append(line)
  }

  private append(line: string) {
    const path = this.path
    if (!path) return
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await appendFile(path, line, { mode: 0o600 })
      })
      .catch(() => {})
  }

  async read() {
    await this.writing
    return this.path ? readFile(this.path, "utf8") : ""
  }

  stream(stream: Stream): Stream {
    const writer = stream.writable.getWriter()
    return {
      readable: stream.readable.pipeThrough(
        new TransformStream<AnyMessage, AnyMessage>({
          transform: (message, controller) => {
            this.record("in", message)
            controller.enqueue(message)
          },
        }),
      ),
      writable: new WritableStream<AnyMessage>({
        write: (message) => {
          this.record("out", message)
          return writer.write(message)
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      }),
    }
  }
}

export function within<A>(promise: Promise<A>, signal: AbortSignal) {
  return new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
