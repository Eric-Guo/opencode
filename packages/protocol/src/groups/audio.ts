import { Audio } from "@opencode-ai/schema/audio"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors.js"
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
  .add(
    HttpApiEndpoint.post("audio.transcriptions", "/api/audio/transcriptions/:sessionID", {
      params: { sessionID: Session.ID },
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "audio/mpeg" })),
      success: Schema.Struct({ data: SessionMessage.Assistant }),
      error: [...errors, InvalidRequestError, SessionNotFoundError],
    })
      .middleware(Authorization)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.audio.transcriptions",
          summary: "Transcribe session audio",
          description:
            "Execute the audio_transcriptions tool with MP3 bytes in a Session and append its redacted call and result to history.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "audio",
      description: "Process-wide audio recording on the OpenCode server host.",
    }),
  )
