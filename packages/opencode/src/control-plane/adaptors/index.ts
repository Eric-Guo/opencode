import { DaytonaAdaptor } from "./daytona"
import { WorktreeAdaptor } from "./worktree"
import type { Config } from "../schema"
import type { Adaptor } from "./types"

export function getAdaptor(config: Config): Adaptor {
  switch (config.type) {
    case "worktree":
      return WorktreeAdaptor
    case "daytona":
      return DaytonaAdaptor
  }
}
