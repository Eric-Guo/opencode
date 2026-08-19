import { WebSearchExa } from "./exa.js"
import { WebSearchFirecrawl } from "./firecrawl.js"
import { WebSearchParallel } from "./parallel.js"
import { SearchKimi } from "./searchkimi.js"
import { WebSearchTavily } from "./tavily.js"

export const WebSearchPlugins = [
  WebSearchExa.Plugin,
  WebSearchFirecrawl.Plugin,
  WebSearchParallel.Plugin,
  SearchKimi.Plugin,
  WebSearchTavily.Plugin,
] as const
