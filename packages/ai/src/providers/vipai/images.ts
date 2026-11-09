import type { ProviderPackage } from "../../provider-package.js"
import { VIPAIImages } from "../../protocols/vipai-images.js"
import { AuthOptions } from "../../route/auth-options.js"
import { MediaRoute } from "../../route/media.js"
import { toConfig } from "../settings.js"

export const model = (modelID: string, settings?: ProviderPackage.Settings & { readonly apiKey?: string | false }) => {
  const input = toConfig(settings)
  return VIPAIImages.model({
    ...MediaRoute.deployment(input, AuthOptions.bearer(input, "VIPAI_API_KEY")),
    id: modelID,
    baseURL: input.baseURL || process.env.VIPAI_BASE_URL,
    providerOptions: input.providerOptions,
  })
}
