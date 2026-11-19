import { readFile, readlink } from "node:fs/promises"
import { hostname } from "node:os"
import type { Info, Provenance } from "./service.js"
import { probeResult } from "./service-probe.js"

/** Linux PIDs and loopback addresses are meaningful only inside their original execution domain. */
export async function provenance(): Promise<Provenance | undefined> {
  if (process.platform !== "linux") return undefined
  const [boot, pidNamespace, netNamespace, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink("/proc/self/ns/pid"),
    readlink("/proc/self/ns/net"),
    readFile("/proc/self/stat", "utf8"),
  ])
  if (stat.slice(0, stat.indexOf(" ")) !== String(process.pid))
    throw new Error("Linux /proc uses a different PID namespace; cannot safely manage service processes")
  return {
    platform: "linux",
    host: hostname(),
    boot: boot.trim(),
    pidNamespace,
    netNamespace,
    started: startTime(stat),
  }
}

/** Fail closed before probing another domain's loopback or changing its registration. */
export async function checkDomain(info: Info) {
  if (process.platform !== "linux") {
    if (info.provenance) throw new Error("Service registration belongs to a different execution domain or namespace")
    return
  }
  const current = await provenance()
  const owner = info.provenance
  if (!owner) {
    throw new Error(
      "Legacy service registration has no execution domain. Stop the old service in its original environment before restarting it.",
    )
  }
  if (typeof owner.started !== "string" || !/^\d+$/.test(owner.started))
    throw new Error("Invalid service process identity; cannot safely replace its owner")
  if (
    !current ||
    owner.platform !== current.platform ||
    owner.host !== current.host ||
    owner.boot !== current.boot ||
    owner.pidNamespace !== current.pidNamespace ||
    owner.netNamespace !== current.netNamespace
  )
    throw new Error(
      "Service registration belongs to a different execution domain or namespace. Use its original environment, or a standalone server with a separate database.",
    )
}

/** Check the registered owner's process identity before connecting to it or signaling it. */
export async function ownerAlive(info: Info) {
  await checkDomain(info)
  if (process.platform !== "linux") {
    try {
      process.kill(info.pid, 0)
      return true
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "ESRCH") return false
        if (process.platform === "win32" && error.code === "EPERM") {
          // Windows can deny even signal 0, for example when a stale PID now belongs to a system process.
          // The service listens before it publishes registration, so check its endpoint for the owning PID.
          const probe = await probeResult(info)
          if (probe.ownerAlive !== undefined) return probe.ownerAlive
        }
      }
      throw error
    }
  }
  const stat = await readFile(`/proc/${info.pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined
    throw error
  })
  if (stat === undefined) return false
  return startTime(stat) === info.provenance?.started && stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"
}

function startTime(stat: string) {
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  if (!started || !/^\d+$/.test(started)) throw new Error("Cannot establish Linux process identity")
  return started
}
