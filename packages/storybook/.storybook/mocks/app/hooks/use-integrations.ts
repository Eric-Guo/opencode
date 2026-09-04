const integrations = [
  { id: "opencode", name: "OpenCode Zen" },
  { id: "opencode-go", name: "OpenCode Go" },
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google" },
  { id: "github-copilot", name: "GitHub Copilot" },
]

export function useIntegrations() {
  return {
    list: () => integrations,
  }
}
