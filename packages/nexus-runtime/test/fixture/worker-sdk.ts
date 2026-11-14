import { NotFound } from "@cybros/agent"
import type { ExtensionAPI } from "../../src/extension-manager"

export function register(api: ExtensionAPI) {
  api.registerCommand("sdk.inspect", async () => {
    const application = api.application()

    return application.client
      .workspace(application.identity.workspace)
      .run("missing")
      .fetch()
      .then(
        () => ({ missing: false }),
        (error: unknown) => ({
          missing: error instanceof NotFound,
          configuration: api.configuration.marker,
          aborted: api.signal.aborted,
        }),
      )
  })
}
