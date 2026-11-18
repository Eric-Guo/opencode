import type { ExecutorClient } from "@cybros/agent"
import { ToolInputError } from "./tool-error"

export function claimAttachments(
  task: ReturnType<ExecutorClient["inboxTask"]>,
  token: string,
  claimSignal: AbortSignal,
) {
  return async (reference: string, signal?: AbortSignal) => {
    const id = /^(?:nexus:\/\/uploads\/)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i
      .exec(reference)?.[1]?.toLowerCase()
    if (!id) throw new ToolInputError("Expected a Nexus attachment reference or upload UUID")

    const active = signal ? AbortSignal.any([signal, claimSignal]) : claimSignal
    active.throwIfAborted()
    const upload = await task.attachment(id, token, { signal: active })

    return {
      id,
      upload,
      async *read() {
        active.throwIfAborted()
        const download = await task.attachmentBytes(id, token, { signal: active })
        if (!download.body) throw new Error("Attachment has no content.")

        let size = 0

        for await (const chunk of download.body) {
          active.throwIfAborted()
          size += chunk.length
          if (size > upload.byte_size) throw new Error("Attachment changed during download.")

          yield chunk
        }
        active.throwIfAborted()
        if (size !== upload.byte_size) throw new Error("Incomplete attachment download.")
      },
    }
  }
}
