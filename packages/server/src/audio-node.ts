export * as AudioRecordingNode from "./audio-node"

import type { RecorderOptions, RecorderStatus } from "@mixtint/audio-recorder-node"
import { Effect, Layer } from "effect"
import { writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { AudioRecording } from "./audio"

export interface Options extends Omit<RecorderOptions, "nativeAddonPath"> {
  readonly nativeAddonPath?: string
}

export function layer(options: Options = {}) {
  return Layer.effect(
    AudioRecording.Service,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const recorderModule = yield* Effect.tryPromise({
          try: () => import("@mixtint/audio-recorder-node"),
          catch: (cause) =>
            new AudioRecording.Error({
              code: "AUDIO_BACKEND_UNAVAILABLE",
              message: "Could not load the audio recording backend.",
              cause,
            }),
        })
        const recorder = recorderModule.createRecorder(options)
        const failure = (cause: unknown) =>
          cause instanceof recorderModule.RecorderError
            ? new AudioRecording.Error({ code: cause.code, message: cause.message, cause })
            : new AudioRecording.Error({
                code: "CAPTURE_START_FAILED",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              })
        const service = AudioRecording.Service.of({
          status: Effect.sync(() => recorder.status()),
          start: Effect.gen(function* () {
            const current = recorder.status()
            if (current.state === "recording") {
              yield* Effect.logDebug("audio recording start repeated", { recordingID: current.recordingID })
              return { status: current, created: false }
            }
            const status = yield* Effect.tryPromise({ try: () => recorder.start(), catch: failure })
            yield* Effect.logInfo("audio recording started", {
              recordingID: status.recordingID,
              backend: status.backend,
            })
            return { status, created: true }
          }).pipe(
            Effect.tapError((error) =>
              Effect.logError("audio recording start failed", { code: error.code, message: error.message }),
            ),
          ),
          stop: (recordingID) =>
            Effect.tryPromise({ try: () => recorder.stop(recordingID), catch: failure }).pipe(
              Effect.map((data) => ({ data, status: recorder.status() })),
              Effect.tap((result) =>
                Effect.logInfo("audio recording stopped", {
                  recordingID,
                  durationMs: result.status.durationMs,
                  size: result.data.byteLength,
                  endReason: result.status.endReason,
                  errorCode: result.status.errorCode,
                }),
              ),
              Effect.tapError((error) =>
                Effect.logError("audio recording stop failed", {
                  recordingID,
                  code: error.code,
                  message: error.message,
                }),
              ),
            ),
        })
        yield* Effect.logInfo("audio recording backend initialized", {
          backend: "@mixtint/audio-recorder-node",
          nativeAddon: options.nativeAddonPath === undefined ? "packaged" : "extracted",
        })
        return { recorder, service }
      }),
      ({ recorder, service }) => shutdown(recorder.status(), service, () => recorder.dispose()),
    ).pipe(Effect.map((value) => value.service)),
  )
}

function shutdown(status: RecorderStatus, service: AudioRecording.Interface, dispose: () => Promise<void>) {
  const persist =
    status.active && status.recordingID
      ? service.stop(status.recordingID).pipe(
          Effect.flatMap((result) =>
            Effect.tryPromise(() => writeFile(path.join(homedir(), "sigma_last_recording.mp3"), result.data)),
          ),
          Effect.tap(() =>
            Effect.logInfo("persisted active audio recording during shutdown", {
              recordingID: status.recordingID,
              path: path.join(homedir(), "sigma_last_recording.mp3"),
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logError("failed to persist active audio recording during shutdown", {
              recordingID: status.recordingID,
              cause,
            }),
          ),
        )
      : Effect.void
  return persist.pipe(
    Effect.andThen(
      Effect.tryPromise(dispose).pipe(
        Effect.catchCause((cause) => Effect.logError("failed to dispose audio recording backend", { cause })),
      ),
    ),
  )
}
