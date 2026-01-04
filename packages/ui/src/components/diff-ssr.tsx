import { type PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { type DiffFileProps } from "./file"
import { FileSSR } from "./file-ssr"

export type DiffProps<T = {}> = Omit<DiffFileProps<T>, "mode"> & {
  preloadedDiff: PreloadMultiFileDiffResult<T>
}

export function Diff<T>(props: DiffProps<T>) {
  return <FileSSR mode="diff" {...props} />
}
