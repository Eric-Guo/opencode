export * as Audio from "./audio.js"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema.js"

export const LifecycleState = Schema.Literals(["idle", "starting", "recording", "stopping", "completed", "failed"])
export type LifecycleState = typeof LifecycleState.Type

export const Backend = Schema.Literals(["native", "arecord"])
export type Backend = typeof Backend.Type

export const EndReason = Schema.Literals(["manual", "unexpected-backend-end", "max-duration"])
export type EndReason = typeof EndReason.Type

export const Permission = Schema.Literals(["not-determined", "restricted", "denied", "authorized", "unknown"])
export type Permission = typeof Permission.Type

export const Environment = Schema.Literals(["local", "remote", "wsl", "headless"])
export type Environment = typeof Environment.Type

export const ErrorCode = Schema.Literals([
  "RECORDER_BUSY",
  "RECORDER_DISPOSED",
  "RECORDING_ID_MISMATCH",
  "RECORDING_NOT_ACTIVE",
  "REMOTE_ENVIRONMENT",
  "UNSUPPORTED_PLATFORM",
  "UNSUPPORTED_ARCHITECTURE",
  "NATIVE_ADDON_MISSING",
  "MICROPHONE_PERMISSION_RESTRICTED",
  "MICROPHONE_PERMISSION_DENIED",
  "AUDIO_BACKEND_UNAVAILABLE",
  "STALE_NATIVE_RECORDING",
  "CAPTURE_START_FAILED",
  "BACKEND_ENDED_UNEXPECTEDLY",
  "PCM_ENCODING_FAILED",
  "MP3_FINALIZATION_FAILED",
  "INVALID_MP3_ARTIFACT",
])
export type ErrorCode = typeof ErrorCode.Type

export const Status = Schema.Struct({
  state: LifecycleState,
  recordingID: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  backend: Schema.NullOr(Backend),
  startedAt: Schema.NullOr(Schema.Finite),
  endedAt: Schema.NullOr(Schema.Finite),
  endReason: Schema.NullOr(EndReason),
  pcmBytes: NonNegativeInt,
  mp3Bytes: NonNegativeInt,
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  progress: Schema.String,
  availability: Schema.Boolean,
  permission: Permission,
  environment: Environment,
  errorCode: Schema.NullOr(ErrorCode),
  errorMessage: Schema.NullOr(Schema.String),
  guidance: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Audio.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}
