import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"

const uid = process.getuid?.()
const maxBytes = 65_536
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

export function id(value: unknown): string {
  if (typeof value !== "string" || !identifier.test(value)) throw new Error("Invalid identifier")
  return value
}

export async function directory(file: string) {
  const stat = await lstat(file)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Expected directory, not symlink")
  if (uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0)
    throw new Error("Expected private same-user directory (0700)")
}

export async function rootDirectory(root: string) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw new Error("Use an absolute normalized sharing directory")
  if ((await realpath(root)) !== root) throw new Error("Sharing path must not contain a symlink")
  await directory(root)
}

export async function privateRead(
  file: string,
  limit = maxBytes,
  retryPublication = false,
  attempt = 0,
): Promise<string> {
  // O_NONBLOCK lets fstat reject a planted FIFO without hanging at open.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP") throw new Error("Expected private regular file, not symlink")
      throw error
    },
  )
  try {
    const stat = await handle.stat()
    // An identical retry can arrive between atomic link publication and staging-link removal.
    if (stat.nlink === 2 && retryPublication && attempt < 20) {
      await handle.close()
      await new Promise((resolve) => setTimeout(resolve, 5))
      return privateRead(file, limit, true, attempt + 1)
    }
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > limit)
      throw new Error("Expected bounded private regular file (0600), without hardlinks")
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

async function syncDirectory(root: string) {
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function publish(root: string, name: string, value: unknown, replace = false, limit = maxBytes) {
  await directory(root)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > limit) throw new Error("Workspace sharing envelope exceeds its size limit")
  const temporary = path.join(root, `.${randomUUID()}.tmp`)
  const destination = path.join(root, name)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(serialized)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (replace) await rename(temporary, destination)
    if (!replace) await link(temporary, destination)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  await syncDirectory(root)
}

export async function initialize(root: string, names = ["requests", "replies"]) {
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  await rootDirectory(root)
  for (const name of names) {
    await mkdir(path.join(root, name), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    await directory(path.join(root, name))
  }
}
