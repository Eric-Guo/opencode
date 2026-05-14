# Session LLM Runtime Boundaries

`../llm.ts` is the opencode session LLM service. It owns opencode concerns: auth, config, model/provider resolution, plugins, permissions, telemetry headers, and runtime selection.

This folder contains adapters behind that service boundary:

- `ai-sdk.ts` converts AI SDK `fullStream` parts into `@opencode-ai/llm` `LLMEvent`s. This is the default runtime path.
- `native-request.ts` converts opencode's normalized session input into a native `@opencode-ai/llm` `LLMRequest`. It does not execute requests.
- `native-runtime.ts` is the opt-in native runtime adapter. It decides whether a selected model is supported, builds the native request, bridges opencode tools into native executable tools, and delegates transport to `LLMClient` / `RequestExecutor`.

Safety boundary:

- AI SDK remains the default.
- `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` is an opt-in hint, not a global replacement. The legacy `OPENCODE_LLM_RUNTIME=native` env var is still accepted by `RuntimeFlags` for local testing.
- Native execution currently runs only for OpenAI-compatible Responses models exposed through `@ai-sdk/openai`: direct `openai` API-key auth and console-managed `opencode`/Zen API-key config.
- Unsupported providers, OpenAI OAuth, and missing API-key cases fall back to AI SDK.
