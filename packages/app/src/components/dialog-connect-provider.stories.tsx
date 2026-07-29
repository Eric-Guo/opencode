// @ts-nocheck
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { mockIntegrationMethods } from "@/context/server-sdk"
import { SettingsProvider } from "@/context/settings"
import { onCleanup, onMount } from "solid-js"
import { DialogConnectProvider, useProviderConnectController } from "./dialog-connect-provider"

function ConnectProviderDialogStory() {
  const dialog = useDialog()
  const open = () => dialog.show(() => <DialogConnectProvider />)

  onMount(open)

  return (
    <Button variant="secondary" onClick={open}>
      Open connect provider dialog
    </Button>
  )
}

function ProviderConnectionDialogStory(props) {
  onCleanup(mockIntegrationMethods(props.provider, props.methods))
  const dialog = useDialog()
  const controller = useProviderConnectController()
  controller.select(props.provider)
  const open = () => dialog.show(() => <DialogConnectProvider controller={controller} />)

  onMount(open)

  return (
    <Button variant="secondary" onClick={open}>
      Open {props.provider} connection dialog
    </Button>
  )
}

function renderConnection(provider, methods) {
  return () => (
    <QueryClientProvider client={new QueryClient()}>
      <SettingsProvider>
        <ProviderConnectionDialogStory provider={provider} methods={methods} />
      </SettingsProvider>
    </QueryClientProvider>
  )
}

export default {
  title: "App/Dialogs/Connect Provider",
  id: "app-dialog-connect-provider",
}

export const V2 = {
  render: () => (
    <QueryClientProvider client={new QueryClient()}>
      <SettingsProvider>
        <ConnectProviderDialogStory />
      </SettingsProvider>
    </QueryClientProvider>
  ),
}

export const ApiKey = {
  render: renderConnection("openrouter", [{ type: "key", label: "API key" }]),
}

export const OpenCodeZen = {
  render: renderConnection("opencode", [{ type: "key", label: "API key" }]),
}

export const LoginMethods = {
  render: renderConnection("openai", [
    { id: "0", type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { id: "1", type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
    { type: "key", label: "API key" },
  ]),
}
