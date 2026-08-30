import { expect, test } from "bun:test"
import { Audio } from "@opencode-ai/schema/audio"
import { Effect, Layer } from "effect"
import { it } from "../../core/test/lib/effect"
import { AudioRecording } from "../src/audio"
import { isLoopbackAddress } from "../src/handlers/audio"
import { ServerFetch } from "../src/fetch"

const auth = { authorization: `Basic ${btoa("opencode:secret")}` }
const options = {
  app: { version: "test-version" },
  password: "secret",
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
  audio: { allowRemote: true },
} as const

const idle: Audio.Status = {
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
  progress: "Ready",
  availability: true,
  permission: "authorized",
  environment: "local",
  errorCode: null,
  errorMessage: null,
  guidance: null,
}

const recording: Audio.Status = {
  ...idle,
  state: "recording",
  recordingID: "recording-1",
  active: true,
  backend: "native",
  startedAt: 1_000,
  progress: "Recording",
}

const completed: Audio.Status = {
  ...recording,
  state: "completed",
  active: false,
  endedAt: 2_000,
  endReason: "manual",
  pcmBytes: 32_000,
  mp3Bytes: 4,
  durationMs: 1_000,
  progress: "Recorded 1.0 seconds",
}

it.live("keeps status public while authenticating recording mutations", () =>
  Effect.gen(function* () {
    const handler = yield* makeHandler(service())
    const status = yield* request(handler, "/api/audio/recording/status")
    expect(status.status).toBe(200)
    expect(yield* Effect.promise(() => status.json())).toEqual(idle)

    expect((yield* request(handler, "/api/audio/recording/start", { method: "POST" })).status).toBe(401)
    expect((yield* request(handler, "/api/audio/recording/recording-1/stop", { method: "POST" })).status).toBe(401)
  }),
)

it.live("rejects untrusted peers by default and permits the explicit remote override", () =>
  Effect.gen(function* () {
    const denied = yield* makeHandler(service(), { allowRemote: false })
    const forbidden = yield* request(denied, "/api/audio/recording/start", { method: "POST", headers: auth })
    expect(forbidden.status).toBe(403)

    const allowed = yield* makeHandler(service())
    expect((yield* request(allowed, "/api/audio/recording/start", { method: "POST", headers: auth })).status).toBe(201)
  }),
)

it.live("uses an unavailable recorder in generic fetch builds", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const status = yield* request(handler, "/api/audio/recording/status")
    expect(status.status).toBe(200)
    expect(yield* Effect.promise(() => status.json())).toMatchObject({
      availability: false,
      errorCode: "AUDIO_BACKEND_UNAVAILABLE",
    })

    const start = yield* request(handler, "/api/audio/recording/start", { method: "POST", headers: auth })
    expect(start.status).toBe(503)
  }),
)

it.live("returns 201 for a new recording and 200 without effect for a repeated start", () =>
  Effect.gen(function* () {
    const recorder = statefulService()
    const handler = yield* makeHandler(recorder)
    const first = yield* request(handler, "/api/audio/recording/start", { method: "POST", headers: auth })
    const second = yield* request(handler, "/api/audio/recording/start", { method: "POST", headers: auth })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(yield* Effect.promise(() => first.json())).toEqual(recording)
    expect(yield* Effect.promise(() => second.json())).toEqual(recording)
  }),
)

it.live("returns retained MP3 bytes and metadata for repeated stop requests", () =>
  Effect.gen(function* () {
    const handler = yield* makeHandler(statefulService(recording))
    const stop = () => request(handler, "/api/audio/recording/recording-1/stop", { method: "POST", headers: auth })
    const first = yield* stop()
    const firstBytes = new Uint8Array(yield* Effect.promise(() => first.arrayBuffer()))
    const second = yield* stop()
    const secondBytes = new Uint8Array(yield* Effect.promise(() => second.arrayBuffer()))

    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("audio/mpeg")
    expect(first.headers.get("content-disposition")).toBe('attachment; filename="recording-1.mp3"')
    expect(first.headers.get("cache-control")).toBe("no-store")
    expect(first.headers.get("x-opencode-recording-id")).toBe("recording-1")
    expect(first.headers.get("x-opencode-recording-duration-ms")).toBe("1000")
    expect(first.headers.get("x-opencode-recording-size")).toBe("4")
    expect(first.headers.get("content-length")).toBe("4")
    expect(firstBytes).toEqual(new Uint8Array([0x49, 0x44, 0x33, 0x04]))
    expect(secondBytes).toEqual(firstBytes)
  }),
)

it.live("returns valid partial MP3 results after an unexpected backend end", () =>
  Effect.gen(function* () {
    const partial = {
      ...completed,
      endReason: "unexpected-backend-end" as const,
      errorCode: "BACKEND_ENDED_UNEXPECTEDLY" as const,
      errorMessage: "The capture device ended unexpectedly.",
    }
    const handler = yield* makeHandler(
      service({
        status: Effect.succeed(partial),
        stop: () => Effect.succeed({ data: new Uint8Array([0x49, 0x44, 0x33, 0x04]), status: partial }),
      }),
    )
    const response = yield* request(handler, "/api/audio/recording/recording-1/stop", {
      method: "POST",
      headers: auth,
    })
    expect(response.status).toBe(200)
    expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(
      new Uint8Array([0x49, 0x44, 0x33, 0x04]),
    )
  }),
)

it.live("maps recorder conflicts, unavailable backends, and encoder failures", () =>
  Effect.gen(function* () {
    const cases = [
      { code: "RECORDER_BUSY" as const, status: 409, tag: "ConflictError" },
      { code: "RECORDING_ID_MISMATCH" as const, status: 409, tag: "ConflictError" },
      { code: "REMOTE_ENVIRONMENT" as const, status: 403, tag: "ForbiddenError" },
      { code: "MICROPHONE_PERMISSION_DENIED" as const, status: 503, tag: "ServiceUnavailableError" },
      { code: "MP3_FINALIZATION_FAILED" as const, status: 500, tag: "UnknownError" },
    ]
    yield* Effect.forEach(cases, (item) =>
      Effect.gen(function* () {
        const handler = yield* makeHandler(
          service({ start: Effect.fail(new AudioRecording.Error({ code: item.code, message: item.code })) }),
        )
        const response = yield* request(handler, "/api/audio/recording/start", { method: "POST", headers: auth })
        expect(response.status).toBe(item.status)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: item.tag, message: item.code })
      }),
    )
  }),
)

test("recognizes only direct numeric loopback peer addresses", () => {
  expect(isLoopbackAddress("127.0.0.1")).toBe(true)
  expect(isLoopbackAddress("127.42.0.9")).toBe(true)
  expect(isLoopbackAddress("::1")).toBe(true)
  expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
  expect(isLoopbackAddress("localhost")).toBe(false)
  expect(isLoopbackAddress("192.168.1.10")).toBe(false)
  expect(isLoopbackAddress("::ffff:192.168.1.10")).toBe(false)
})

function service(overrides: Partial<AudioRecording.Interface> = {}) {
  return AudioRecording.Service.of({
    status: Effect.succeed(idle),
    start: Effect.succeed({ status: recording, created: true }),
    stop: () => Effect.succeed({ data: new Uint8Array([0x49, 0x44, 0x33, 0x04]), status: completed }),
    ...overrides,
  })
}

function statefulService(initial: Audio.Status = idle) {
  const state = { status: initial }
  return AudioRecording.Service.of({
    status: Effect.sync(() => state.status),
    start: Effect.sync(() => {
      if (state.status.state === "recording") return { status: state.status, created: false }
      state.status = recording
      return { status: state.status, created: true }
    }),
    stop: (recordingID) => {
      if (recordingID !== "recording-1")
        return Effect.fail(
          new AudioRecording.Error({ code: "RECORDING_ID_MISMATCH", message: "Recording ID mismatch" }),
        )
      state.status = completed
      return Effect.succeed({ data: new Uint8Array([0x49, 0x44, 0x33, 0x04]), status: state.status })
    },
  })
}

function makeHandler(
  audio: AudioRecording.Interface,
  config: { readonly allowRemote: boolean } = { allowRemote: true },
) {
  return ServerFetch.make(
    { ...options, audio: config },
    { overrides: [[AudioRecording.node, Layer.succeed(AudioRecording.Service, audio)]] },
  )
}

function request(handler: (request: Request) => Promise<Response>, path: string, init?: RequestInit) {
  return Effect.promise(() => handler(new Request(`http://opencode.local${path}`, init)))
}
