import type { ExtensionErrorCode, ExtensionFailure } from "../../shared/ipc-rpc/extensions"

/** A failure the renderer maps to its own copy by `code`. */
export class ExtensionError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    options?: ErrorOptions & { readonly message?: string },
  ) {
    super(options?.message ?? code, options)
  }
}

export function extensionFailure(cause: unknown): ExtensionFailure {
  if (cause instanceof ExtensionError) return { code: cause.code, message: cause.message }

  return { code: "failed", message: cause instanceof Error ? cause.message : String(cause) }
}
