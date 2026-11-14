import { readFile, realpath, rm, stat } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import { Schema } from "effect"
import { atomic, missing } from "./storage"
import { resolvePath } from "./file-read"

/** API-owned state is separate from pairing settings; clearing it restores their root. */
export class DefaultEnvironment {
  private override?: string
  private configured?: string
  private queue = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly protectedRoots: readonly string[],
  ) {}

  async restore(configured: string) {
    this.configured = configured
    const stored = await readFile(this.file, "utf8").catch((error: unknown) => {
      if (missing(error)) return undefined
      throw error
    })
    this.override =
      stored === undefined
        ? undefined
        : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ root: Schema.NonEmptyString })))(stored).root
    return this.root
  }

  get root() {
    const root = this.current
    if (!root) throw new Error("The runner has no default directory yet.")
    return root
  }

  get current() {
    return this.override ?? this.configured
  }

  get source() {
    return this.override ? "api" : "settings"
  }

  change(root: string | null, publish: (root: string, persist: () => Promise<void>) => Promise<void>) {
    const pending = this.queue.then(async () => {
      const next = root === null ? undefined : await realpath(resolvePath(this.root, root))
      const directory = next ?? this.configured!
      if (!(await stat(directory)).isDirectory()) throw new Error(directory + " is not a directory")
      if (
        this.protectedRoots.some((root) => {
          const from = relative(root, directory)
          return !isAbsolute(from) && from !== ".." && !from.startsWith(".." + sep)
        })
      )
        throw new Error(directory + " is under a protected root")
      const previous = this.override
      this.override = next
      await publish(directory, () => (next ? atomic(this.file, { root: next }) : rm(this.file, { force: true }))).catch(
        (error: unknown) => {
          this.override = previous
          throw error
        },
      )
      return { root: this.root, source: this.source }
    })
    this.queue = pending.then(
      () => {},
      () => {},
    )
    return pending
  }
}
