import { createSimpleContext } from "./helper"
import { createMarkdownParser } from "./marked-parser"

export { OpenCodeTheme } from "./highlight-theme"

// Extension renderers still consume this context; share the markdown worker's parser.
export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: createMarkdownParser,
})
