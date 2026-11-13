import type { CredentialStore, CredentialDocument } from "@cybros/agent"
import { readFile, rename, rm, writeFile } from "node:fs/promises"

export function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export async function atomic(path: string, value: object) {
  const temporary = path + "." + crypto.randomUUID() + ".tmp"
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function vault(path: string): CredentialStore {
  let queue = Promise.resolve()
  return {
    read: () =>
      readFile(path, "utf8")
        .then((value): unknown => JSON.parse(value))
        .catch((error) => {
          if (missing(error)) return null
          throw error
        }),
    write: (document: CredentialDocument) => atomic(path, document),
    delete: () => rm(path, { force: true }),
    withLock<T>(operation: () => Promise<T>) {
      const pending = queue.then(operation)
      queue = pending.then(
        () => {},
        () => {},
      )
      return pending
    },
  }
}
