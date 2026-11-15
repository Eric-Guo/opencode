/** A tool request the caller can correct without retrying the executor. */
export class ToolInputError extends Error {}

export function toolFailure(error: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  if (
    error instanceof ToolInputError ||
    (error instanceof Error &&
      "code" in error &&
      [
        "ENOENT",
        "ENOTDIR",
        "EISDIR",
        "EACCES",
        "EPERM",
        "ELOOP",
        "ENAMETOOLONG",
        "EROFS",
        "ENOSPC",
        "ERR_ENCODING_INVALID_ENCODED_DATA",
      ].includes(String(error.code)))
  )
    return { is_error: true, content: error.message }
  throw error
}
