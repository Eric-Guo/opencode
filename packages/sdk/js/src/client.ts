export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

const OPENCODE_DIRECTORY_HEADER_PREFIX = "opencode-uri:"

export function createOpencodeClient(config?: Config & { directory?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    const directoryHeader = OPENCODE_DIRECTORY_HEADER_PREFIX + encodeURIComponent(config.directory)
    if (config.headers instanceof Headers || Array.isArray(config.headers)) {
      const headers = new Headers(config.headers)
      headers.set("x-opencode-directory", directoryHeader)
      config = {
        ...config,
        headers,
      }
    } else {
      config = {
        ...config,
        headers: {
          ...(config.headers ?? {}),
          "x-opencode-directory": directoryHeader,
        },
      }
    }
  }

  const client = createClient(config)
  return new OpencodeClient({ client })
}
