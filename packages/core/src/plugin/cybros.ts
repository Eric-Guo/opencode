/** @deprecated Use `@opencode/thape/cybros`. Removed in the next minor. */
export * as CybrosTrace from "./cybros.js"

import { CybrosTrace } from "@opencode/thape/cybros"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { MyTodo } from "../my-todo.js"
import { InstallationVersion } from "../installation/version.js"
import { SessionStore } from "../session/store.js"

/** @deprecated Use `CybrosTrace.build` from `@opencode/thape/cybros`. Removed in the next minor. */
export function build(session: Session.Info, messages: readonly SessionMessage.Info[], workPackageID?: number) {
  return CybrosTrace.build({ session, messages, workPackageID }, InstallationVersion)
}

/** @deprecated Use `CybrosTrace.create` from `@opencode/thape/cybros`. Removed in the next minor. */
export const Plugin = define({
  id: CybrosTrace.ID,
  effect: Effect.fn(function* (ctx: Context) {
    const sessions = yield* SessionStore.Service

    yield* CybrosTrace.create({
      version: InstallationVersion,
      read: Effect.fn(function* (sessionID: Session.ID) {
        const session = yield* sessions.get(sessionID)
        if (!session) return

        return {
          session,
          messages: yield* sessions.context(sessionID),
          workPackageID: (yield* MyTodo.selected(session.projectID))?.work_package_id,
        }
      }),
    }).effect(ctx)
  }),
})
