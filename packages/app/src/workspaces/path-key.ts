import { comparablePath } from "@opencode/util/path"

export type PathKey = string & { _brand: "PathKey" }

// SAFETY: comparablePath normalizes paths to the sole canonical representation accepted as workspace keys.
export const pathKey = (path: string) => comparablePath(path) as PathKey
