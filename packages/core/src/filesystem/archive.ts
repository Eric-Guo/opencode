import { Effect, FileSystem } from "effect"
import type { Archive, ArchiveEntry } from "@opencode/schema/filesystem"

class ArchiveError extends Error {
  constructor(readonly status: "invalid" | "unsupported" | "limit" | "timeout") {
    super(status)
  }
}

/** Reads bounded directory metadata only. No entry data, extraction, or path resolution. */
export function readArchive(file: FileSystem.File) {
  return Effect.gen(function* () {
    const info = yield* file.stat.pipe(Effect.orDie)
    const size = Number(info.size)

    if (info.type !== "File" || !Number.isSafeInteger(size)) return { status: "unsupported", size: 0 } satisfies Archive

    return yield* Effect.tryPromise({
      try: (signal) => readDirectory(file, size, signal),
      catch: (error) => (error instanceof ArchiveError ? error.status : ("invalid" as const)),
    }).pipe(Effect.catch((status) => Effect.succeed({ status, size } satisfies Archive)))
  })
}

async function readDirectory(file: FileSystem.File, size: number, signal: AbortSignal): Promise<Archive> {
  const { Reader, ZipReader, ERR_SPLIT_ZIP_FILE } = await import("@zip.js/zip.js")
  const deadline = performance.now() + 5_000
  const timeout = AbortSignal.timeout(5_000)
  const cancellation = AbortSignal.any([signal, timeout])
  const budget = { bytes: 0, names: 0 }
  const reader = new Reader(file)

  reader.size = size
  reader.readUint8Array = async (offset, length) => {
    signal.throwIfAborted()

    if (timeout.aborted || performance.now() >= deadline) throw new ArchiveError("timeout")

    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > size
    )
      throw new ArchiveError("invalid")

    // zip.js requests the central directory in one allocation, before yielding entries.
    // Enforce both allocation and total I/O budgets at this boundary, including its fallback reads.
    budget.bytes += length

    if (length > 4 * 1024 * 1024 || budget.bytes > 12 * 1024 * 1024) throw new ArchiveError("limit")

    const buffer = new Uint8Array(length)
    const read = await Effect.runPromise(file.seek(offset, "start").pipe(Effect.andThen(file.read(buffer))), {
      signal: cancellation,
    })

    if (Number(read) !== length) throw new ArchiveError("invalid")

    return buffer
  }

  const zip = new ZipReader(reader, { useWebWorkers: false })
  const entries: ArchiveEntry[] = []
  const parents = new Set<string>()

  return (async () => {
    for await (const entry of zip.getEntriesGenerator()) {
      signal.throwIfAborted()

      if (timeout.aborted || performance.now() >= deadline) throw new ArchiveError("timeout")

      budget.names += entry.filename.length

      if (
        entries.length >= 5_000 ||
        entry.rawFilename.length > 1_024 ||
        entry.filename.length > 1_024 ||
        budget.names > 1_048_576
      )
        throw new ArchiveError("limit")

      const segments = entry.filename.split("/")

      if (segments.length > 65) throw new ArchiveError("limit")

      if (!entry.filename || /[\u0000-\u001f\u007f]/.test(entry.filename)) throw new ArchiveError("unsupported")

      segments.slice(0, -1).forEach((_, index) => parents.add(segments.slice(0, index + 1).join("/")))

      if (parents.size + entries.length >= 10_000) throw new ArchiveError("limit")

      if (
        ![entry.uncompressedSize, entry.compressedSize, entry.offset].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new ArchiveError("invalid")

      if (entry.diskNumberStart !== 0) throw new ArchiveError("unsupported")

      entries.push({
        id: entries.length,
        name: entry.filename,
        directory: entry.directory,
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        encrypted: entry.encrypted,
        symlink: entry.versionMadeBy >> 8 === 3 && ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000,
        compressionMethod: entry.compressionMethod,
      })
    }

    return { status: "ready", size, entries } satisfies Archive
  })()
    .catch((error) => {
      if (timeout.aborted) throw new ArchiveError("timeout")

      if (error instanceof Error && error.message === ERR_SPLIT_ZIP_FILE) throw new ArchiveError("unsupported")

      throw error
    })
    .finally(() => zip.close())
}
