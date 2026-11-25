import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { app, crashReporter } from "electron"
import { marks } from "../lifecycle/marks"

let startup: { readonly path: string } | { readonly error: unknown } | undefined

export function startCrashReporter() {
  if (startup) return startup

  try {
    const path = join(app.getPath("userData"), "Crashpad")
    mkdirSync(path, { recursive: true })
    app.setPath("crashDumps", path)
    crashReporter.start({ uploadToServer: false, compress: true })
    marks.crash = Date.now()
    startup = { path }
  } catch (error) {
    startup = { error }
  }

  return startup
}
