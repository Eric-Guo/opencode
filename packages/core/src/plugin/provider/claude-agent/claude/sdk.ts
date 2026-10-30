export * as ClaudeSDK from "./sdk.js"

// Loaded on first use, so opencode starts without loading the SDK.
let sdk: ReturnType<typeof importSDK> | undefined

export function load() {
  sdk ??= importSDK()
  return sdk
}

function importSDK() {
  return import("#claude-agent-sdk").catch((cause) => {
    // Let the next request try again, for example after the SDK is installed.
    sdk = undefined
    throw new Error("Claude Agent SDK isn't installed. Install @anthropic-ai/claude-agent-sdk to use Claude Agent.", {
      cause,
    })
  })
}
