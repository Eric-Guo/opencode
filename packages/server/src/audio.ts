export * as AudioRecording from "./audio"

import { Audio } from "@opencode-ai/schema/audio"
import { Context, Data, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"

export class Error extends Data.TaggedError("AudioRecordingError")<{
  readonly code: Audio.ErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Interface {
  readonly status: Effect.Effect<Audio.Status>
  readonly start: Effect.Effect<{ readonly status: Audio.Status; readonly created: boolean }, Error>
  readonly stop: (
    recordingID: string,
  ) => Effect.Effect<{ readonly data: Uint8Array; readonly status: Audio.Status }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServerAudioRecording") {}

export interface Options {
  readonly allowRemote?: boolean
  readonly maxDurationMs?: number
  readonly remoteEnvironmentHint?: boolean
}

export const Config = Context.Reference<Options | undefined>("@opencode/ServerAudioRecordingConfig", {
  defaultValue: () => undefined,
})

const status: Audio.Status = {
  state: "idle",
  recordingID: null,
  active: false,
  backend: null,
  startedAt: null,
  endedAt: null,
  endReason: null,
  pcmBytes: 0,
  mp3Bytes: 0,
  durationMs: 0,
  progress: "Audio recording is unavailable",
  availability: false,
  permission: "unknown",
  environment: "headless",
  errorCode: "AUDIO_BACKEND_UNAVAILABLE",
  errorMessage: "Audio recording is unavailable in this runtime.",
  guidance: "Run the OpenCode Node server on a supported host with microphone access.",
}

export const unavailable = Layer.effect(
  Service,
  Effect.logInfo("audio recording backend unavailable", { backend: "unavailable" }).pipe(
    Effect.as(
      Service.of({
        status: Effect.succeed(status),
        start: Effect.fail(
          new Error({
            code: "AUDIO_BACKEND_UNAVAILABLE",
            message: status.errorMessage ?? "Audio recording is unavailable.",
          }),
        ),
        stop: () =>
          Effect.fail(
            new Error({
              code: "AUDIO_BACKEND_UNAVAILABLE",
              message: status.errorMessage ?? "Audio recording is unavailable.",
            }),
          ),
      }),
    ),
  ),
)

export const node = makeGlobalNode({ service: Service, layer: unavailable, deps: [] })
