import type { MigrationV1StatusOutput } from "@opencode/client/promise"
import { useGlobal, useLanguage, type ServerConnection } from "@opencode/app/desktop"
import { Loader } from "@opencode/ui/loader"
import { showToast, toaster, Toast } from "@opencode/ui/toast"
import { createRoot, createSignal } from "solid-js"
import { createMigrationStatusPoller } from "./migration-status-poller"

type Progress = Extract<MigrationV1StatusOutput, { status: "running" }>["progress"]

export function MigrationStatus(props: { server: ServerConnection.Any }) {
  const language = useLanguage()
  const sdk = useGlobal().ensureServerCtx(props.server).sdk
  const [progress, setProgress] = createSignal<Progress>()
  let toastID: number | undefined
  let disposeToast: (() => void) | undefined

  const hide = () => {
    if (toastID !== undefined) toaster.dismiss(toastID)
    toastID = undefined
    disposeToast?.()
    disposeToast = undefined
  }

  const show = () => {
    if (toastID !== undefined) return
    toastID = toaster.show(
      ({ toastId }) =>
        createRoot((dispose) => {
          disposeToast?.()
          disposeToast = dispose
          return (
            <Toast toastId={toastId}>
              <div data-slot="toast-v2-header" class="col-span-full">
                <Toast.Icon>
                  <Loader />
                </Toast.Icon>
                <Toast.Content>
                  <Toast.Title dir="auto">{format(progress())}</Toast.Title>
                </Toast.Content>
              </div>
            </Toast>
          )
        }),
      { persistent: true },
    )
  }

  createMigrationStatusPoller({
    connected: () => sdk.connection.status() === "connected",
    status: (signal) => sdk.api.migration.v1.status({ signal }),
    onStatus(status) {
      setProgress(status.status === "running" ? status.progress : undefined)
      if (status.status === "running") return show()
      hide()
    },
    onError(error) {
      hide()
      showToast({
        variant: "error",
        title: language.t("toast.migration.failed.title"),
        description: error instanceof Error ? error.message : String(error),
        duration: 10_000,
      })
    },
    onCleanup: hide,
  })

  return null
}

function format(progress: Progress | undefined) {
  if (!progress) return ""
  if (progress.numerator === undefined) return progress.label
  if (progress.denominator === undefined) return `${progress.label} ${progress.numerator}`
  return `${progress.label} ${progress.numerator}/${progress.denominator}`
}
