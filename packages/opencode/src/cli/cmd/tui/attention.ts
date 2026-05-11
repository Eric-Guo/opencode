import { Audio, type AudioErrorContext, type AudioSound } from "@opentui/core"
import type {
  TuiAttention,
  TuiAttentionNotifyInput,
  TuiAttentionNotifyResult,
  TuiAttentionNotifySkipReason,
} from "@opencode-ai/plugin/tui"
import stripAnsi from "strip-ansi"
import type { TuiConfig } from "./config/tui"
import attentionSoundPath from "./asset/pulse-a.wav" with { type: "file" }
import * as Log from "@opencode-ai/core/util/log"

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
  triggerNotification(message: string, title?: string): boolean
}

type AttentionAudioEngine = {
  on(event: "error", listener: (error: Error, context: AudioErrorContext) => void): unknown
  isStarted(): boolean
  start(): boolean
  loadSound(data: Uint8Array | ArrayBuffer): AudioSound | null
  play(sound: AudioSound, options?: { volume?: number }): unknown | null
  dispose(): void
}

type AttentionAudio = {
  create(): AttentionAudioEngine
  bytes(): Promise<Uint8Array>
}

export type TuiAttentionHost = TuiAttention & {
  dispose(): void
}

const log = Log.create({ service: "tui.attention" })

const DEFAULT_TITLE = "opencode"
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240

function skipped(reason: TuiAttentionNotifySkipReason): TuiAttentionNotifyResult {
  return {
    ok: false,
    notification: false,
    sound: false,
    skipped: reason,
  }
}

function normalizeText(input: string | undefined, fallback: string, limit: number) {
  const text = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  const normalized = text.length ? text : fallback
  return Array.from(normalized).slice(0, limit).join("")
}

function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return 0
  return Math.min(1, Math.max(0, volume))
}

function soundVolume(input: TuiAttentionNotifyInput, config: Pick<TuiConfig.Resolved, "attention">) {
  if (!config.attention.sound) return
  if (input.sound === undefined || input.sound === false) return
  if (input.sound === true) return clampVolume(config.attention.volume)
  if (input.sound.enabled === false) return
  return clampVolume(input.sound.volume ?? config.attention.volume)
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<TuiConfig.Resolved, "attention">
  audio?: AttentionAudio
}): TuiAttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false
  let audio: AttentionAudioEngine | undefined
  let sound: AudioSound | null | undefined
  let soundTask: Promise<AudioSound | null> | undefined

  const audioInput =
    input.audio ??
    ({
      create: () => {
        const engine = Audio.create({ autoStart: false })
        engine.on("error", (error, context) => {
          log.debug("attention audio error", { error, context })
        })
        return engine
      },
      bytes: () => Bun.file(attentionSoundPath).bytes(),
    } satisfies AttentionAudio)

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  async function loadSound() {
    if (!audio) return null
    if (sound !== undefined) return sound
    soundTask ??= audioInput
      .bytes()
      .then((bytes) => audio?.loadSound(bytes) ?? null)
      .catch((error) => {
        log.debug("failed to load attention sound", { error })
        return null
      })
    sound = await soundTask
    return sound
  }

  async function playSound(volume: number) {
    try {
      audio ??= audioInput.create()
      if (!audio.isStarted() && !audio.start()) return false
      const current = await loadSound()
      if (current == null) return false
      return audio.play(current, { volume }) != null
    } catch (error) {
      log.debug("failed to play attention sound", { error })
      return false
    }
  }

  return {
    async notify(request) {
      try {
        if (!input.config.attention.enabled) return skipped("attention_disabled")
        if (disposed || input.renderer.isDestroyed) return skipped("renderer_destroyed")

        const message = normalizeText(request.message, "", MESSAGE_LIMIT)
        if (!message) return skipped("empty_message")

        if (focus === "focused") return skipped("focused")
        if (focus === "unknown") return skipped("focus_unknown")

        const notification = input.config.attention.notifications
          ? (() => {
              try {
                return input.renderer.triggerNotification(message, normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT))
              } catch (error) {
                log.debug("failed to trigger attention notification", { error })
                return false
              }
            })()
          : false
        const volume = soundVolume(request, input.config)
        const sound = volume === undefined ? false : await playSound(volume)

        return {
          ok: notification || sound,
          notification,
          sound,
        }
      } catch (error) {
        log.debug("failed to handle attention notification", { error })
        return {
          ok: false,
          notification: false,
          sound: false,
        }
      }
    },
    dispose() {
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
      audio?.dispose()
      audio = undefined
      sound = undefined
      soundTask = undefined
    },
  }
}
