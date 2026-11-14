import type { PeerConfig, RTCDataChannel, RTCPeerConnection } from "werift"

export type RealtimeOptions = {
  servers?: PeerConfig["iceServers"]
  relay?: boolean
  ports?: [number, number]
  addresses?: string[]
}

/** Handler-owned TypeScript replacement for rho-env's Go DataChannel helper. */
export class RealtimePeer {
  private incoming: Array<{ bytes: Buffer; at: number }> = []
  private overflow = false
  private nonce = 0

  private constructor(
    private readonly peer: RTCPeerConnection,
    private readonly data: RTCDataChannel,
    private readonly permission: RTCDataChannel,
  ) {
    data.onMessage.subscribe((message) => {
      const bytes = Buffer.from(message)

      if (bytes.length > 16384 || this.incoming.length >= 4) {
        this.overflow = true
        return
      }

      this.incoming.push({ bytes, at: performance.now() })
    })
    permission.onMessage.subscribe((message) => {
      if (Buffer.byteLength(message) > 16) return

      const value = Number(message.toString())

      if (Number.isSafeInteger(value) && value > 0) this.nonce = value
    })
  }

  static async create(options: RealtimeOptions = {}) {
    const { RTCPeerConnection } = await import("werift")
    const peer = new RTCPeerConnection({
      iceServers: options.servers ?? [],
      iceUseDefaultStunServer: false,
      iceTransportPolicy: options.relay ? "relay" : "all",
      icePortRange: options.ports,
      iceAdditionalHostAddresses: options.addresses ?? ["127.0.0.1"],
    })

    return new RealtimePeer(
      peer,
      peer.createDataChannel("terminal", { negotiated: true, ordered: true, id: 0 }),
      peer.createDataChannel("permission", { negotiated: true, ordered: true, id: 1 }),
    )
  }

  async offer() {
    await this.peer.setLocalDescription(await this.peer.createOffer())

    return this.peer.localDescription!.sdp
  }

  async answer(sdp: string) {
    await this.peer.setRemoteDescription({ type: "offer", sdp })
    await this.peer.setLocalDescription(await this.peer.createAnswer())

    return this.peer.localDescription!.sdp
  }

  remote(sdp: string) {
    return this.peer.setRemoteDescription({ type: "answer", sdp })
  }

  send(bytes: Buffer | string) {
    if (Buffer.byteLength(bytes) > 16384) throw new Error("Realtime block exceeds 16 KiB.")
    if (this.data.readyState !== "open" || this.data.bufferedAmount + Buffer.byteLength(bytes) > 65536) return false

    this.data.send(bytes)

    return true
  }

  poll(maxAgeMs: number, allowedSince = 0) {
    if (this.overflow) throw new Error("Realtime receive buffer overflow.")

    const incoming = this.incoming

    this.incoming = []

    if (this.nonce && this.permission.readyState === "open" && this.permission.bufferedAmount <= 1024) {
      this.permission.send(
        JSON.stringify({ nonce: this.nonce, max_age_ms: Math.floor(Math.max(0, Math.min(1000, maxAgeMs))) }),
      )
      this.nonce = 0
    }

    return {
      ready: this.data.readyState === "open",
      state: this.peer.connectionState,
      data: incoming
        .filter((block) => block.at >= allowedSince && performance.now() - block.at < maxAgeMs)
        .map((block) => block.bytes),
    }
  }

  close() {
    this.incoming = []
    return this.peer.close()
  }
}

/** Bounded output history persists across peers; omitted bytes retain truthful stream offsets. */
export class OutputWindow {
  private chunks: Array<{ offset: number; bytes: Buffer }> = []
  private retained = 0
  offset = 0

  constructor(private readonly maxBytes = 262144) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid output window size.")
  }

  append(bytes: Buffer, retain: boolean) {
    if (!Number.isSafeInteger(this.offset + bytes.length)) throw new Error("Output offset overflow.")

    if (retain) {
      for (let start = 0; start < bytes.length; start += 8192) {
        const block = Buffer.from(bytes.subarray(start, start + 8192))

        this.chunks.push({ offset: this.offset + start, bytes: block })
        this.retained += block.length
      }
    }

    this.offset += bytes.length

    while (this.retained > this.maxBytes || this.chunks.length > 256) this.retained -= this.chunks.shift()!.bytes.length
  }

  frame(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.offset) throw new Error("Invalid resume offset.")

    const chunk = this.chunks.find((entry) => entry.offset + entry.bytes.length > offset)

    if (chunk && offset >= chunk.offset)
      return { type: "output", offset, data: chunk.bytes.subarray(offset - chunk.offset).toString("base64") }
    if (offset < this.offset) return { type: "gap", from: offset, to: chunk ? this.chunks.at(-1)!.offset : this.offset }
  }

  clear() {
    this.chunks = []
    this.retained = 0
  }
}
