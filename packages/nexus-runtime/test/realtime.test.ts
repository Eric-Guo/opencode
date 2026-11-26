import { expect, test } from "bun:test"
import { OutputWindow, RealtimeLease, RealtimePeer } from "../src/realtime"
import { browserTools } from "../src/browser"
import { tmpdir } from "node:os"
import { Schema } from "effect"
import { APIError } from "@cybros/agent"

test("terminal output resumes with explicit gaps for uncaptured or evicted bytes", () => {
  const window = new OutputWindow(8)

  window.append(Buffer.from("private"), false)
  window.append(Buffer.from("hello"), true)
  expect(window.frame(0)).toEqual({ type: "gap", from: 0, to: 7 })
  expect(window.frame(7)).toEqual({ type: "output", offset: 7, data: Buffer.from("hello").toString("base64") })
  window.append(Buffer.from("world"), true)
  expect(window.frame(7)).toEqual({ type: "gap", from: 7, to: 12 })
  expect(window.frame(14)).toEqual({ type: "output", offset: 14, data: Buffer.from("rld").toString("base64") })
  expect(() => window.frame(100)).toThrow("resume")
  window.clear()
  expect(window.frame(14)).toEqual({ type: "gap", from: 14, to: 17 })
})

test("terminal permission expires from request start and cannot revive a replaced or refused connection", () => {
  const lease = new RealtimeLease()
  const snapshot = {
    status: "active",
    reason: null,
    connection_id: "first",
    offer_sdp: null,
    answer_sdp: null,
    max_age_ms: 1000,
    ice_servers: null,
  }
  lease.begin("first")
  lease.accept("first", snapshot, performance.now() - 2000)
  expect(lease.allowed).toBe(false)
  lease.accept("first", snapshot, performance.now())
  expect(lease.allowed).toBe(true)
  expect(lease.remaining).toBeLessThanOrEqual(1000)
  lease.begin("second")
  lease.accept("first", snapshot, performance.now())
  expect(lease.allowed).toBe(false)
  expect(lease.closed).toBe(false)
  lease.accept("second", snapshot, performance.now())
  expect(lease.closed).toBe(true)
  expect(() => lease.begin("third")).toThrow("closed")
  const refusal = new RealtimeLease()
  refusal.begin("first")
  refusal.accept("first", snapshot, performance.now())
  refusal.unavailable(new APIError("not claimant", 409, "not_claimant", null, null, null))
  expect(refusal.closed).toBe(true)
  expect(refusal.remaining).toBe(0)
})

// Real ICE/DTLS/SCTP negotiation establishes that no Go or native WebRTC addon is required.
test("TypeScript WebRTC peers negotiate the Nexus terminal channels and carry bounded bytes", async () => {
  const first = await RealtimePeer.create()
  const second = await RealtimePeer.create()
  const deadline = AbortSignal.timeout(10000)

  try {
    await first.remote(await second.answer(await first.offer()))

    while (!first.poll(1000).ready || !second.poll(1000).ready) {
      deadline.throwIfAborted()
      await Bun.sleep(5)
    }

    expect(first.send("terminal bytes")).toBe(true)

    while (true) {
      deadline.throwIfAborted()

      const packet = second.poll(1000)

      if (packet.data.length) {
        expect(packet.data[0].toString()).toBe("terminal bytes")
        break
      }

      await Bun.sleep(5)
    }

    expect(() => first.send(Buffer.alloc(16385))).toThrow("16 KiB")
  } finally {
    await Promise.all([first.close(), second.close()])
  }
}, 15000)

const chromium = process.env.OPENCODE_NEXUS_CHROMIUM

test.skipIf(!chromium)(
  "TypeScript terminal transport interoperates with Chromium",
  async () => {
    const peer = await RealtimePeer.create()
    const owner = new AbortController()
    const tools = browserTools(chromium!, owner.signal)
    const evaluate = async (expression: string) => {
      const result = await tools
        .find((tool) => tool.definition.name === "browser_evaluate")!
        .execute(
          { expression },
          {
            directory: tmpdir(),
            workspace: "fixture",
            conversation: "webrtc",
            run: "run",
            task: "task",
            signal: owner.signal,
          },
        )

      return Schema.decodeUnknownSync(Schema.String)(result.structured_content)
    }

    try {
      const answer = await evaluate(`(async()=>{
      globalThis.pc = new RTCPeerConnection({iceServers:[]});
      globalThis.channel = pc.createDataChannel("terminal",{negotiated:true,ordered:true,id:0});
      globalThis.permission = pc.createDataChannel("permission",{negotiated:true,ordered:true,id:1});
      channel.binaryType = "arraybuffer";
      globalThis.received = "";
      channel.onmessage = event => { received = new TextDecoder().decode(event.data); };
      await pc.setRemoteDescription({type:"offer",sdp:${JSON.stringify(await peer.offer())}});
      await pc.setLocalDescription(await pc.createAnswer());
      if(pc.iceGatheringState!=="complete") await new Promise(resolve=>pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==="complete")resolve()});
      return pc.localDescription.sdp;
    })()`)

      await peer.remote(answer)

      const deadline = AbortSignal.timeout(10000)

      while (!peer.poll(1000).ready) {
        deadline.throwIfAborted()
        await Bun.sleep(5)
      }

      peer.send(Buffer.from("browser terminal"))

      while ((await evaluate("received")) !== "browser terminal") {
        deadline.throwIfAborted()
        await Bun.sleep(5)
      }

      expect(await evaluate('(channel.send("browser reply"),"sent")')).toBe("sent")

      while (true) {
        deadline.throwIfAborted()

        const received = peer.poll(1000).data

        if (received.length) {
          expect(received[0].toString()).toBe("browser reply")
          break
        }

        await Bun.sleep(5)
      }
    } finally {
      owner.abort()
      await peer.close()
    }
  },
  20000,
)
