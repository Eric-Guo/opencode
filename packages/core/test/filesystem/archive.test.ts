import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, FileSystem } from "effect"
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { readArchive } from "../../src/filesystem/archive"
import { testEffect } from "../lib/effect"

const { effect: it, live } = testEffect(LayerNode.compile(FSUtil.node))

it(
  "reads ZIP64 metadata without reading the large member",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const directory = yield* fs.makeTempDirectoryScoped()
    const writer = new ZipWriter(new Uint8ArrayWriter(), { zip64: true })
    const data = yield* Effect.promise(async () => {
      await writer.add("中文/文件.bin", new Uint8ArrayReader(new Uint8Array(2 * 1024 * 1024)), { level: 0 })

      return writer.close()
    })

    yield* fs.writeFile(path.join(directory, "large.zip"), data)

    const file = yield* fs.open(path.join(directory, "large.zip"))
    const reads: number[] = []
    const instrumented = observeRead(file, (buffer) => {
      reads.push(buffer.byteLength)

      return file.read(buffer)
    })
    const result = yield* readArchive(instrumented)

    expect(result).toMatchObject({
      status: "ready",
      size: data.length,
      entries: [{ id: 0, name: "中文/文件.bin", size: 2 * 1024 * 1024, directory: false }],
    })
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(2_000)
  }),
)

live(
  "cancels an in-flight directory read with its owner",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const directory = yield* fs.makeTempDirectoryScoped()

    yield* fs.writeFile(path.join(directory, "archive.zip"), centralDirectory([]))

    const file = yield* fs.open(path.join(directory, "archive.zip"))
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const reader = yield* readArchive(
      observeRead(file, () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      ),
    ).pipe(Effect.forkScoped({ startImmediately: true }))

    yield* Deferred.await(started)
    yield* Fiber.interrupt(reader)
    yield* Deferred.await(stopped)

    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)

live(
  "bounds a stalled directory read to five seconds",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const directory = yield* fs.makeTempDirectoryScoped()

    yield* fs.writeFile(path.join(directory, "archive.zip"), centralDirectory([]))

    const file = yield* fs.open(path.join(directory, "archive.zip"))
    const stopped = yield* Deferred.make<void>()
    const result = yield* readArchive(
      observeRead(file, () => Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)))),
    )

    expect(result).toEqual({ status: "timeout", size: 22 })
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
  8_000,
)

function observeRead(file: FileSystem.File, read: FileSystem.File["read"]): FileSystem.File {
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: file.stat,
    seek: (offset, from) => file.seek(offset, from),
    sync: file.sync,
    readAlloc: (size) => file.readAlloc(size),
    truncate: (size) => file.truncate(size),
    write: (buffer) => file.write(buffer),
    writeAll: (buffer) => file.writeAll(buffer),
    read,
  }
}

for (const input of [
  { name: "empty", data: centralDirectory([]), status: "ready", count: 0 },
  {
    name: "duplicates and special members",
    data: centralDirectory(["中文/文件.txt", "中文/文件.txt", "../link", "secret"]),
    status: "ready",
    count: 4,
  },
  { name: "invalid format", data: new TextEncoder().encode("not a zip archive"), status: "invalid" },
  { name: "truncated directory", data: centralDirectory(["ok"]).subarray(0, 48), status: "invalid" },
  {
    name: "too many entries",
    data: centralDirectory(Array.from({ length: 5_001 }, (_, index) => `${index}`)),
    status: "limit",
  },
  { name: "long name", data: centralDirectory(["x".repeat(1_025)]), status: "limit" },
  { name: "deep name", data: centralDirectory([Array.from({ length: 66 }, () => "d").join("/")]), status: "limit" },
  {
    name: "too many implicit directories",
    data: centralDirectory(
      Array.from({ length: 200 }, (_, index) => `${index}/${Array.from({ length: 60 }, () => "d").join("/")}`),
    ),
    status: "limit",
  },
  { name: "control character", data: centralDirectory(["a\0b"]), status: "unsupported" },
  { name: "split archive", data: centralDirectory(["ok"], { disk: 1 }), status: "unsupported" },
  {
    name: "huge directory allocation",
    data: centralDirectory(["ok"], { directorySize: 5 * 1024 * 1024 }),
    status: "limit",
  },
] as const) {
  it(
    `handles ${input.name}`,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const directory = yield* fs.makeTempDirectoryScoped()

      yield* fs.writeFile(path.join(directory, "archive.zip"), input.data)

      const file = yield* fs.open(path.join(directory, "archive.zip"))
      const result = yield* readArchive(file)

      expect(result.status).toBe(input.status)

      if (result.status !== "ready") return

      expect(result.entries).toHaveLength("count" in input ? (input.count ?? 0) : 0)

      if (input.name !== "duplicates and special members") return

      expect(result.entries.map((entry) => entry.name)).toEqual(["中文/文件.txt", "中文/文件.txt", "../link", "secret"])
      expect(result.entries.map((entry) => entry.id)).toEqual([0, 1, 2, 3])
      expect(result.entries[2]?.symlink).toBe(true)
      expect(result.entries[3]?.encrypted).toBe(true)
      expect(result.entries[3]?.compressionMethod).toBe(99)
      expect(yield* fs.readDirectory(directory)).toEqual(["archive.zip"])
    }),
  )
}

// Central-only fixtures deliberately have no member data: preview must never open it.
function centralDirectory(names: string[], options?: { disk?: number; directorySize?: number }) {
  const records = names.map((name) => {
    const filename = Buffer.from(name)
    const header = Buffer.alloc(46)

    header.writeUInt32LE(0x02014b50)
    header.writeUInt16LE((3 << 8) | 20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x800 | (name === "secret" ? 1 : 0), 8)
    header.writeUInt16LE(name === "secret" ? 99 : 0, 10)
    header.writeUInt32LE(12, 24)
    header.writeUInt16LE(filename.length, 28)
    header.writeUInt32LE(name === "../link" ? (0xa000 << 16) >>> 0 : 0, 38)

    return Buffer.concat([header, filename])
  })
  const directory = Buffer.concat(records)
  const footer = Buffer.alloc(22)

  footer.writeUInt32LE(0x06054b50)
  footer.writeUInt16LE(options?.disk ?? 0, 4)
  footer.writeUInt16LE(names.length, 8)
  footer.writeUInt16LE(names.length, 10)
  footer.writeUInt32LE(options?.directorySize ?? directory.length, 12)

  // Large-directory fixtures stay sparse in content while presenting a valid in-range read request.
  return Buffer.concat([Buffer.alloc(Math.max(0, (options?.directorySize ?? 0) - directory.length)), directory, footer])
}
