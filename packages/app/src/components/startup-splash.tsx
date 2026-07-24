import { Splash } from "@opencode-ai/ui/logo"
import "./startup-splash.css"

export function StartupSplash() {
  return (
    <div data-component="startup-splash" role="status" aria-label="天华 AI 协作平台正在启动">
      <div data-slot="background" aria-hidden="true">
        <span data-slot="aurora" data-variant="cyan" />
        <span data-slot="aurora" data-variant="violet" />
        <span data-slot="grid" />
        <span data-slot="particles" />
        <span data-slot="scanline" />
      </div>

      <div data-slot="content">
        <div data-slot="mark">
          <span data-slot="orbit" aria-hidden="true" />
          <Splash class="w-80 h-80 opacity-50 animate-pulse" />
        </div>

        <div data-slot="brand">
          <h1>天华 AI 协作平台</h1>
          <p>TIANHUA AI COLLABORATION PLATFORM</p>
          <div data-slot="signal" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>
  )
}
