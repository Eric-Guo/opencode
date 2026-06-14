import type { ThemeRegistrationResolved } from "shiki"

export type MarkdownToken = [content: string, style: string]

export type MarkdownWorkerRequest =
  | { type: "init"; theme: ThemeRegistrationResolved }
  | { type: "highlight"; id: number; key: string; text: string; language: string; complete?: boolean }
  | { type: "dispose"; key: string }

export type MarkdownWorkerResponse =
  | {
      type: "highlight"
      id: number
      key: string
      reset: boolean
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }
  | { type: "error"; id: number; key: string; message: string }

export type MarkdownWorkerState = {
  id: number
  stable: MarkdownToken[]
  unstable: MarkdownToken[]
}

export function applyMarkdownWorkerResponse(
  state: MarkdownWorkerState | undefined,
  response: Extract<MarkdownWorkerResponse, { type: "highlight" }>,
) {
  if (state && response.id <= state.id) return state
  return {
    id: response.id,
    stable: response.reset ? response.stable : [...(state?.stable ?? []), ...response.stable],
    unstable: response.unstable,
  }
}
