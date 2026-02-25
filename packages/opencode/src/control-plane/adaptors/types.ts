import type { Config } from "../schema"

export type Adaptor<T extends Config = Config> = {
  create(from: T, branch: string): Promise<{ config: T; init: () => Promise<void> }>
  remove(from: T): Promise<void>
  request(from: T, method: string, url: string, data?: BodyInit, signal?: AbortSignal): Promise<Response | undefined>
}
