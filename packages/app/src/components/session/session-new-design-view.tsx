import type { JSX } from "solid-js"
import { Splash } from "@opencode-ai/ui/logo"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          <Splash class="mx-auto h-40 w-40 text-v2-icon-icon-base" />
          <div class="mt-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
