import { ConflictError, ForbiddenError, ServiceUnavailableError, UnknownError } from "@opencode-ai/protocol/errors"
import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { AudioRecording } from "../audio"

export const AudioHandler = HttpApiBuilder.group(Api, "server.audio", (handlers) =>
  Effect.gen(function* () {
    const audio = yield* AudioRecording.Service
    const config = yield* AudioRecording.Config
    return handlers
      .handleRaw("audio.recording.start", (request) =>
        trusted(request.request, config).pipe(
          Effect.andThen(audio.start),
          Effect.mapError(mapError),
          Effect.map((result) => HttpServerResponse.jsonUnsafe(result.status, { status: result.created ? 201 : 200 })),
        ),
      )
      .handleRaw("audio.recording.stop", (request) =>
        trusted(request.request, config).pipe(
          Effect.andThen(audio.stop(request.params.recordingID)),
          Effect.mapError(mapError),
          Effect.map((result) =>
            HttpServerResponse.uint8Array(result.data, {
              contentType: "audio/mpeg",
              headers: {
                "content-disposition": `attachment; filename="${request.params.recordingID}.mp3"`,
                "cache-control": "no-store",
                "x-opencode-recording-id": request.params.recordingID,
                "x-opencode-recording-duration-ms": String(result.status.durationMs),
                "x-opencode-recording-size": String(result.data.byteLength),
              },
            }),
          ),
        ),
      )
      .handle("audio.recording.status", () => audio.status)
  }),
)

function trusted(request: HttpServerRequest.HttpServerRequest, config: AudioRecording.Options | undefined) {
  if (config?.allowRemote) return Effect.void
  if (Option.exists(request.remoteAddress, isLoopbackAddress)) return Effect.void
  return Effect.fail(
    new ForbiddenError({
      message: "Remote audio recording is disabled. Restart the server with --allow-remote-audio to enable it.",
    }),
  )
}

export function isLoopbackAddress(address: string) {
  if (address === "::1") return true
  const ipv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
  const parts = ipv4.split(".")
  return (
    parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function mapError(error: AudioRecording.Error | ForbiddenError) {
  if (error instanceof ForbiddenError) return error
  if (error.code === "REMOTE_ENVIRONMENT") return new ForbiddenError({ message: error.message })
  if (error.code === "RECORDER_BUSY" || error.code === "RECORDING_ID_MISMATCH" || error.code === "RECORDING_NOT_ACTIVE")
    return new ConflictError({ message: error.message, resource: "audio.recording" })
  if (
    error.code === "PCM_ENCODING_FAILED" ||
    error.code === "MP3_FINALIZATION_FAILED" ||
    error.code === "INVALID_MP3_ARTIFACT"
  )
    return new UnknownError({ message: error.message })
  return new ServiceUnavailableError({ message: error.message, service: "audio.recording" })
}
