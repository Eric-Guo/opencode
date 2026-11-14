import { appendFileSync, closeSync, openSync, renameSync, writeSync } from "node:fs"
import { open } from "node:fs/promises"

const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\r/g

/** The bounded memory buffer remains readable even if the optional log mirror fails. */
export class ProcessOutput {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private partial = Buffer.alloc(0)
  private dropped = 0
  private file?: number
  private bytes = 0
  private first: string | null = null
  private matched: string | null = null
  last: string | null = null
  ended = false
  error?: string

  constructor(
    readonly path: string,
    private readonly waitFor?: string,
    private readonly onLine?: (line: string) => void,
    private readonly rotateAt = 8 * 1024 * 1024,
  ) {}

  get ready() {
    return this.matched ?? this.first
  }
  get readyMatched() {
    return this.matched !== null
  }

  append(chunk: Buffer) {
    const room = Math.max(0, 64 * 1024 - this.head.length)
    this.head = Buffer.concat([this.head, chunk.subarray(0, room)])
    this.tail = Buffer.concat([this.tail, chunk.subarray(room)])
    const overflow = this.tail.length - 256 * 1024
    if (overflow > 0) {
      const newline = this.tail.indexOf(10, overflow)
      const cut = newline < 0 ? overflow : newline + 1
      this.tail = this.tail.subarray(cut)
      this.dropped += cut
    }
    this.partial = Buffer.concat([this.partial, chunk])
    for (let newline = this.partial.indexOf(10); newline >= 0; newline = this.partial.indexOf(10)) {
      this.note(this.partial.subarray(0, newline))
      this.partial = this.partial.subarray(newline + 1)
    }
    if (this.partial.length > 16 * 1024) this.partial = this.partial.subarray(-4096)
    if (this.error) return
    try {
      this.file ??= openSync(this.path, "a", 0o600)
      let offset = 0
      while (offset < chunk.length) offset += writeSync(this.file, chunk, offset)
      this.bytes += chunk.length
      if (this.bytes < this.rotateAt) return
      this.close()
      renameSync(this.path, this.path + ".1")
      this.bytes = 0
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.close()
    }
  }

  end() {
    if (this.ended) return
    this.ended = true
    if (this.partial.length) this.note(this.partial)
    this.partial = Buffer.alloc(0)
    this.close()
  }

  exit(line: string) {
    if (this.error) return
    try {
      appendFileSync(this.path, line + "\n", { mode: 0o600 })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  }

  lines(count: number, maximum = 50 * 1024) {
    const text = clean(
      Buffer.concat([
        this.head,
        ...(this.dropped
          ? [Buffer.from(`\n[… ${this.dropped} bytes of earlier output dropped; the log file has it …]\n`)]
          : []),
        this.tail,
      ]),
    )
    const selected = text.replace(/\n$/, "").split("\n").slice(-count).join("\n")
    if (Buffer.byteLength(selected) <= maximum) return selected
    return Buffer.from(selected)
      .subarray(-maximum)
      .toString("utf8")
      .replace(/^.*?\n/, "")
      .replace(/\ufffd/g, "")
  }

  static async tail(path: string, count: number, maximum = 50 * 1024) {
    const file = await open(path, "r").catch(() => undefined)
    if (!file) return ""
    try {
      const size = (await file.stat()).size
      const buffer = Buffer.alloc(Math.min(maximum, size))
      const result = await file.read(buffer, 0, buffer.length, Math.max(0, size - maximum))
      return clean(buffer.subarray(0, result.bytesRead)).replace(/\n$/, "").split("\n").slice(-count).join("\n")
    } finally {
      await file.close()
    }
  }

  private note(raw: Buffer) {
    const line = Buffer.from(clean(raw).trim())
      .subarray(0, 4096)
      .toString("utf8")
      .replace(/\ufffd$/g, "")
    if (!line) return
    this.first ??= line
    this.last = line
    if (this.waitFor && line.toLowerCase().includes(this.waitFor.toLowerCase())) this.matched ??= line
    this.onLine?.(line)
  }

  private close() {
    if (this.file === undefined) return
    try {
      closeSync(this.file)
    } catch {}
    this.file = undefined
  }
}

function clean(value: Buffer) {
  return value
    .toString("utf8")
    .replace(/\ufffd/g, "?")
    .replace(ansi, "")
}
