import { Audio, type AudioErrorContext, type AudioSound } from "@opentui/core"
import type {
  TuiAttention,
  TuiAttentionNotifyInput,
  TuiAttentionNotifyResult,
  TuiAttentionNotifySkipReason,
  TuiAttentionWhen,
  TuiKV,
  TuiAttentionSoundName,
  TuiAttentionSoundPack,
  TuiAttentionSoundPackInfo,
} from "@opencode-ai/plugin/tui"
import stripAnsi from "strip-ansi"
import type { TuiConfig } from "./config/tui"
import defaultSoundPath from "@opencode-ai/ui/audio/bip-bop-01.mp3" with { type: "file" }
import questionSoundPath from "@opencode-ai/ui/audio/bip-bop-03.mp3" with { type: "file" }
import permissionSoundPath from "@opencode-ai/ui/audio/staplebops-06.mp3" with { type: "file" }
import errorSoundPath from "@opencode-ai/ui/audio/nope-03.mp3" with { type: "file" }
import doneSoundPath from "@opencode-ai/ui/audio/bip-bop-01.mp3" with { type: "file" }
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
  loadSoundFile(file: string): Promise<AudioSound | null>
  play(sound: AudioSound, options?: { volume?: number }): unknown | null
  dispose(): void
}

type AttentionAudio = {
  create(): AttentionAudioEngine
}

type RegisteredSoundPack = TuiAttentionSoundPack & {
  builtin: boolean
}

export type TuiAttentionHost = TuiAttention & {
  dispose(): void
}

const log = Log.create({ service: "tui.attention" })

const DEFAULT_TITLE = "opencode"
const DEFAULT_PACK_ID = "opencode.default"
const KV_SOUND_PACK = "attention_sound_pack"
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240
const SOUND_NAMES: readonly TuiAttentionSoundName[] = [
  "default",
  "question",
  "permission",
  "error",
  "done",
]
const BUILTIN_PACK: RegisteredSoundPack = {
  id: DEFAULT_PACK_ID,
  name: "OpenCode Default",
  builtin: true,
  sounds: {
    default: defaultSoundPath,
    question: questionSoundPath,
    permission: permissionSoundPath,
    error: errorSoundPath,
    done: doneSoundPath,
  },
}

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
  if (input.sound === false) return
  if (input.sound === undefined) return clampVolume(config.attention.volume)
  if (input.sound === true) return clampVolume(config.attention.volume)
  return clampVolume(input.sound.volume ?? config.attention.volume)
}

function soundName(input: TuiAttentionNotifyInput): TuiAttentionSoundName {
  if (typeof input.sound === "object")
    return input.sound.name && isSoundName(input.sound.name) ? input.sound.name : "default"
  return "default"
}

function notificationEnabled(input: TuiAttentionNotifyInput) {
  if (input.notification === false) return false
  return true
}

function notificationWhen(input: TuiAttentionNotifyInput) {
  if (typeof input.notification === "object" && input.notification.when) return input.notification.when
  return "blurred"
}

function soundWhen(input: TuiAttentionNotifyInput) {
  if (typeof input.sound === "object" && input.sound.when) return input.sound.when
  return "always"
}

function isSoundName(value: string): value is TuiAttentionSoundName {
  return SOUND_NAMES.includes(value as TuiAttentionSoundName)
}

function normalizePack(pack: TuiAttentionSoundPack): RegisteredSoundPack | undefined {
  const id = pack.id.trim()
  if (!id) return
  return {
    id,
    name: pack.name?.trim() || undefined,
    builtin: false,
    sounds: Object.fromEntries(
      Object.entries(pack.sounds).filter(
        (item): item is [TuiAttentionSoundName, string] =>
          isSoundName(item[0]) && typeof item[1] === "string" && item[1].trim().length > 0,
      ),
    ),
  }
}

function focusSkip(when: TuiAttentionWhen, focus: FocusState) {
  if (when === "always") return
  if (focus === "unknown") return "focus_unknown"
  if (when === "blurred" && focus === "focused") return "focused"
  if (when === "focused" && focus === "blurred") return "blurred"
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<TuiConfig.Resolved, "attention">
  kv?: TuiKV
  audio?: AttentionAudio
}): TuiAttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false
  let audio: AttentionAudioEngine | undefined
  let activePackID: string | undefined
  const packs = new Map<string, RegisteredSoundPack>([[BUILTIN_PACK.id, BUILTIN_PACK]])
  const sounds = new Map<string, Promise<AudioSound | null>>()

  const audioInput: AttentionAudio =
    input.audio ?? {
      create: () => {
        const engine = Audio.create({ autoStart: false })
        engine.on("error", (error, context) => {
          log.debug("attention audio error", { error, context })
        })
        return engine
      },
    }

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  function configuredPackID() {
    const stored = input.kv?.get<string | undefined>(KV_SOUND_PACK, undefined)
    return activePackID ?? stored ?? input.config.attention.sound_pack
  }

  function currentPack() {
    return packs.get(configuredPackID()) ?? BUILTIN_PACK
  }

  function soundCandidates(name: TuiAttentionSoundName) {
    return [input.config.attention.sounds[name], currentPack().sounds[name], BUILTIN_PACK.sounds[name]].filter(
      (item, index, list): item is string => typeof item === "string" && list.indexOf(item) === index,
    )
  }

  async function loadSound(file: string) {
    if (!audio) return null
    const cached = sounds.get(file)
    if (cached) return cached
    const task = audio.loadSoundFile(file).catch((error) => {
      log.debug("failed to load attention sound", { file, error })
      return null
    })
    sounds.set(file, task)
    return task
  }

  async function playSound(name: TuiAttentionSoundName, volume: number) {
    try {
      audio ??= audioInput.create()
      if (!audio.isStarted() && !audio.start()) return false
      for (const file of soundCandidates(name)) {
        const current = await loadSound(file)
        if (current == null) continue
        if (audio.play(current, { volume }) != null) return true
      }
      return false
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

        const notificationSkip = focusSkip(notificationWhen(request), focus)
        const notificationRequested = input.config.attention.notifications && notificationEnabled(request)
        const shouldNotify = notificationRequested && !notificationSkip
        const notification = shouldNotify
          ? (() => {
              try {
                return input.renderer.triggerNotification(
                  message,
                  normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT),
                )
              } catch (error) {
                log.debug("failed to trigger attention notification", { error })
                return false
              }
            })()
          : false
        const volume = soundVolume(request, input.config)
        const soundSkip = volume === undefined ? undefined : focusSkip(soundWhen(request), focus)
        const sound = volume === undefined || soundSkip ? false : await playSound(soundName(request), volume)

        if (!notification && !sound) {
          if (notificationRequested && notificationSkip) return skipped(notificationSkip)
          if (soundSkip) return skipped(soundSkip)
        }

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
    soundboard: {
      registerPack(pack) {
        const next = normalizePack(pack)
        if (!next) return () => {}
        packs.set(next.id, next)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          if (packs.get(next.id) === next) packs.delete(next.id)
        }
      },
      activate(id, options) {
        const pack = packs.get(id)
        if (!pack) return false
        activePackID = pack.id
        if (options?.persist) input.kv?.set(KV_SOUND_PACK, pack.id)
        return true
      },
      current() {
        return currentPack().id
      },
      list(): TuiAttentionSoundPackInfo[] {
        const current = currentPack().id
        return Array.from(packs.values()).map((pack) => ({
          id: pack.id,
          name: pack.name,
          active: pack.id === current,
          builtin: pack.builtin,
        }))
      },
    },
    dispose() {
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
      audio?.dispose()
      audio = undefined
      sounds.clear()
    },
  }
}
