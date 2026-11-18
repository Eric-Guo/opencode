import { Schema } from "effect"

const User = Schema.Struct({
  id: Schema.Int,
  is_bot: Schema.optional(Schema.Boolean),
  first_name: Schema.optional(Schema.String),
  last_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
})
const Media = Schema.Struct({
  file_id: Schema.String,
  file_size: Schema.optional(Schema.Number),
  file_name: Schema.optional(Schema.String),
  mime_type: Schema.optional(Schema.String),
})
const Entity = Schema.Struct({
  type: Schema.String,
  offset: Schema.Int,
  length: Schema.Int,
  user: Schema.optional(User),
})
const Message = Schema.Struct({
  message_id: Schema.Int,
  date: Schema.optional(Schema.Int),
  from: Schema.optional(User),
  chat: Schema.Struct({ id: Schema.Int, type: Schema.String }),
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  entities: Schema.optional(Schema.Array(Entity)),
  caption_entities: Schema.optional(Schema.Array(Entity)),
  is_topic_message: Schema.optional(Schema.Boolean),
  message_thread_id: Schema.optional(Schema.Int),
  reply_to_message: Schema.optional(
    Schema.Struct({ message_id: Schema.Int, from: Schema.optional(User), text: Schema.optional(Schema.String) }),
  ),
  document: Schema.optional(Media),
  voice: Schema.optional(Media),
  photo: Schema.optional(Schema.Array(Media)),
  audio: Schema.optional(Media),
  video: Schema.optional(Media),
  video_note: Schema.optional(Media),
  animation: Schema.optional(Media),
  sticker: Schema.optional(Media),
})
export const TelegramRawUpdate = Schema.StructWithRest(Schema.Struct({ update_id: Schema.Int }), [
  Schema.Record(Schema.String, Schema.MutableJson),
])
const Update = Schema.Struct({
  update_id: Schema.Int,
  message: Schema.optional(Message),
  stopped_message_generation: Schema.optional(
    Schema.Struct({ draft_id: Schema.Int, chat: Schema.Struct({ id: Schema.Int, type: Schema.String }) }),
  ),
  callback_query: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      from: User,
      message: Schema.optional(Message),
      data: Schema.optional(Schema.String),
    }),
  ),
})

export class TelegramUpdate {
  readonly value
  readonly message
  readonly user
  readonly text
  readonly media

  constructor(input: unknown) {
    this.value = Schema.decodeUnknownSync(Update)(input)
    this.message = this.value.stopped_message_generation
      ? ({ message_id: 0, chat: this.value.stopped_message_generation.chat } as typeof Message.Type)
      : (this.value.callback_query?.message ?? this.value.message)
    this.user = this.value.callback_query?.from ?? this.message?.from
    this.text = this.message?.text ?? this.message?.caption ?? ""
    const photo = this.message?.photo?.at(-1)
    const voice = this.message?.voice
    const file = this.message?.document
    this.media = photo
      ? { ...photo, kind: "image", filename: "photo.jpg", content_type: "image/jpeg" }
      : voice
        ? { ...voice, kind: "voice", filename: "voice.ogg", content_type: voice.mime_type ?? "audio/ogg" }
        : file
          ? {
              ...file,
              kind: file.mime_type?.startsWith("image/") ? "image" : "file",
              filename: file.file_name ?? "attachment",
              content_type: file.mime_type ?? "application/octet-stream",
            }
          : undefined
  }

  get id() {
    return this.value.update_id
  }
  get supported() {
    return (
      !!this.message &&
      (this.value.stopped_message_generation ? this.message.chat.type === "private" : !!this.user && !this.user.is_bot)
    )
  }
  get chat() {
    return String(this.message?.chat.id)
  }
  get requester() {
    return this.value.stopped_message_generation ? this.chat : String(this.user?.id)
  }
  get topic() {
    return this.message?.is_topic_message ? (this.message.message_thread_id ?? null) : null
  }
  get group() {
    return this.message?.chat.type !== "private"
  }
  get reply() {
    return this.message?.reply_to_message?.message_id
  }
  get unsupportedMedia() {
    return (
      !this.media &&
      !!(
        this.message?.audio ||
        this.message?.video ||
        this.message?.video_note ||
        this.message?.animation ||
        this.message?.sticker
      )
    )
  }
  stale(now: number, seconds: number) {
    return (
      !this.value.callback_query &&
      !this.value.stopped_message_generation &&
      now / 1000 - (this.message?.date ?? 0) > seconds
    )
  }
  command(botName: string) {
    const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(this.text)
    if (!match) return this.text.startsWith("/") ? { name: "unknown", argument: "" } : undefined
    if (match[2] && match[2].toLowerCase() !== botName.toLowerCase())
      return { name: "addressed_elsewhere", argument: "" }
    return { name: match[1].toLowerCase(), argument: match[3]?.trim() ?? "" }
  }
  mentions(bot: { id: string; username: string }) {
    return (
      (this.message?.text ? this.message.entities : this.message?.caption_entities)?.some((entity) =>
        entity.type === "text_mention"
          ? String(entity.user?.id) === bot.id
          : entity.type === "mention" &&
            this.text.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
              "@" + bot.username.toLowerCase(),
      ) ?? false
    )
  }
}
