import { Audio } from "@opencode-ai/schema/audio"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, ForbiddenError, ServiceUnavailableError, UnknownError } from "../errors.js"
import { Authorization } from "../middleware/authorization.js"

const errors = [ConflictError, ForbiddenError, ServiceUnavailableError, UnknownError] as const

export const AudioGroup = HttpApiGroup.make("server.audio")
  .add(
    HttpApiEndpoint.post("audio.recording.start", "/api/audio/recording/start", {
      success: [Audio.Status, Audio.Status.pipe(HttpApiSchema.status(201))],
      error: errors,
    })
      .middleware(Authorization)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.audio.recording.start",
          summary: "Start audio recording",
          description: "Start recording the default microphone on the OpenCode server host.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("audio.recording.stop", "/api/audio/recording/:recordingID/stop", {
      params: { recordingID: Schema.String },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "audio/mpeg" })),
      error: errors,
    })
      .middleware(Authorization)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.audio.recording.stop",
          summary: "Stop audio recording",
          description: "Stop one server-host recording and return its retained MP3 bytes.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("audio.recording.status", "/api/audio/recording/status", {
      success: Audio.Status,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.audio.recording.status",
        summary: "Get audio recording status",
        description: "Report process-wide server-host recording state and availability.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "audio",
      description: "Process-wide audio recording on the OpenCode server host.",
    }),
  )
