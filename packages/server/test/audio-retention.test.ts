import { expect, test } from "bun:test"
import {
  AudioRecorder,
  createRecorderDependencies,
} from "../node_modules/@mixtint/audio-recorder-node/dist/recorder.js"
import type { NativeAudioAddon } from "../node_modules/@mixtint/audio-recorder-node/dist/native.js"

test("completed recordings release the encoder and retain independent MP3 stop results", async () => {
  const fixture = recorder()
  const started = await fixture.recorder.start()
  fixture.capture.onData(Buffer.alloc(8_820))
  const [first, concurrent] = await Promise.all([
    fixture.recorder.stop(started.recordingID!),
    fixture.recorder.stop(started.recordingID!),
  ])
  expect(first.byteLength).toBeGreaterThan(0)
  expect(concurrent).toEqual(first)
  expect(fixture.recorder.status()).toMatchObject({ state: "completed", active: false })
  const repeated = await fixture.recorder.stop(started.recordingID!)
  expect(repeated).toEqual(first)
  first.fill(0)
  expect(await fixture.recorder.stop(started.recordingID!)).toEqual(repeated)
  await released(fixture.encoders)

  // Keep the native callback alive, as an addon may do after capture ends.
  fixture.capture.onData(Buffer.alloc(10))
  const next = await fixture.recorder.start()
  expect(next.recordingID).not.toBe(started.recordingID)
  fixture.capture.onData(Buffer.alloc(8_820))
  await fixture.recorder.dispose()
  expect(fixture.recorder.status().state).toBe("completed")
  expect((await fixture.recorder.stop(next.recordingID!)).byteLength).toBeGreaterThan(0)
  await released(fixture.encoders)
})

test("failed finalization releases the encoder and preserves repeated-stop errors", async () => {
  const fixture = recorder({ fail: true })
  const started = await fixture.recorder.start()
  const failure = await fixture.recorder.stop(started.recordingID!).catch((error: unknown) => error)
  expect(failure).toMatchObject({ code: "MP3_FINALIZATION_FAILED" })
  expect(fixture.recorder.status()).toMatchObject({ state: "failed", active: false })
  expect(await fixture.recorder.stop(started.recordingID!).catch((error: unknown) => error)).toBe(failure)
  await released(fixture.encoders)
  fixture.capture.onData(Buffer.alloc(10))
  await fixture.recorder.dispose()
})

test("automatic duration stops release the encoder without a stop caller", async () => {
  const fixture = recorder({ maxDurationMs: 10 })
  const started = await fixture.recorder.start()
  fixture.capture.onData(Buffer.alloc(8_820))
  for (let attempt = 0; attempt < 100 && fixture.recorder.status().active; attempt++) await Bun.sleep(10)
  expect(fixture.recorder.status().state).toBe("completed")
  expect(fixture.recorder.status().endReason).toBe("max-duration")
  await released(fixture.encoders)
  expect((await fixture.recorder.stop(started.recordingID!)).byteLength).toBeGreaterThan(0)
  await fixture.recorder.dispose()
})

test("failed capture starts release the encoder even if native callbacks remain", async () => {
  const fixture = recorder({ start: false })
  await expect(fixture.recorder.start()).rejects.toMatchObject({ code: "CAPTURE_START_FAILED" })
  await released(fixture.encoders)
  fixture.capture.onData(Buffer.alloc(10))
  await fixture.recorder.dispose()
})

function recorder(options: { fail?: boolean; start?: boolean; maxDurationMs?: number } = {}) {
  const runtime = createRecorderDependencies()
  const encoders: WeakRef<object>[] = []
  const capture = {
    active: false,
    onData: (() => {}) as Parameters<NativeAudioAddon["startRecording"]>[0],
  }
  const addon: NativeAudioAddon = {
    startRecording(onData) {
      capture.onData = onData
      capture.active = options.start ?? true
      return capture.active
    },
    stopRecording() {
      capture.active = false
    },
    isRecording: () => capture.active,
    microphoneAuthorizationStatus: () => 3,
  }
  return {
    capture,
    encoders,
    recorder: new AudioRecorder(
      { maxDurationMs: options.maxDurationMs },
      {
        ...runtime,
        platform: "darwin",
        env: {},
        loadNative: () => ({ addon, error: null }),
        createEncoder: async () => {
          const encoder = await runtime.createEncoder()
          encoders.push(new WeakRef(encoder))
          if (options.fail)
            encoder.finalize = () => {
              throw new Error("finalization failed")
            }
          return encoder
        },
      },
    ),
  }
}

async function released(encoders: WeakRef<object>[]) {
  // Timer callbacks and WeakRef reads can keep objects alive until the next job.
  for (let attempt = 0; attempt < 20; attempt++) {
    await Bun.sleep(10)
    Bun.gc(true)
    if (encoders.every((encoder) => encoder.deref() === undefined)) return
  }
  expect(encoders.map((encoder) => encoder.deref())).toEqual(encoders.map(() => undefined))
}
