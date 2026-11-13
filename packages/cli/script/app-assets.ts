import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants } from "node:zlib"
import { AppArchive } from "../src/app-archive"
import { collectFiles } from "./files"

export async function buildAppArchive(channel: string, version: string, options?: { skipBuild?: boolean }) {
  if (options?.skipBuild) return AppArchive.encode([])

  // Turbo can build the web app while the desktop or CLI builds its embedded copy.
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-app-"))

  try {
    await $`bun run build`.cwd(path.resolve(import.meta.dirname, "../../app")).env({
      ...process.env,
      OPENCODE_APP_OUTDIR: directory,
      OPENCODE_CHANNEL: channel,
      VITE_OPENCODE_SERVER_MODE: "origin",
      VITE_OPENCODE_VERSION: version,
    })

    return AppArchive.encode(
      await Promise.all(
        (await collectFiles(directory))
          .map((key) => key.replaceAll(path.sep, "/"))
          .filter((key) => !key.endsWith(".map"))
          .toSorted()
          .map(async (key) => {
            const body = Buffer.from(await Bun.file(path.join(directory, key)).arrayBuffer())

            // Independent entries let the server materialize only assets the browser requests.
            return [key, await compress(body, channel)] as const
          }),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// Production archives favor size. Preview builds repeat locally and in CI, where quality 9 avoids the much slower
// quality 11 compression at the cost of a slightly larger embedded web UI.
function compress(body: Buffer, channel: string) {
  return promisify(brotliCompress)(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: channel === "latest" || channel === "prod" ? 11 : 9,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  })
}
