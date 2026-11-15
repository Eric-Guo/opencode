import { Worker } from "node:worker_threads"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { ExtensionAPI, ExtensionDocument, ExtensionModule } from "./extension-manager"
import type { RunnerContext, RunnerTool } from "./extensions"
import { ExtensionRPC, extensionRPCBootstrap } from "./extension-rpc"
import { isTurnGate, type TurnGate } from "./extension-lifecycle"

const bootstrap =
  String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const url = require("node:url");
const moduleAPI = require("node:module");
let transpile;
if (!process.versions.bun && moduleAPI.registerHooks) {
  moduleAPI.registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (error) {
        if ((!specifier.startsWith(".") && !specifier.startsWith("file:")) || !context.parentURL) throw error;
        const base = new URL(specifier, context.parentURL);
        if (base.protocol !== "file:") throw error;
        const path = url.fileURLToPath(base);
        const candidates = [path.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts"), ...[".ts", ".js", ".mjs", "/index.ts", "/index.js"].map(suffix => path + suffix)];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return next(url.pathToFileURL(candidate).href, context);
        }
        throw error;
      }
    },
    load(location, context, next) {
      if (!location.startsWith("file:") || !/\.(?:ts|mts|cts)$/.test(new URL(location).pathname)) return next(location, context);
      const input = fs.readFileSync(new URL(location), "utf8");
      let source;
      try { source = moduleAPI.stripTypeScriptTypes(input, { mode: "strip", sourceUrl: location }); }
      catch (error) {
        if (error?.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw error;
        source = transpile(input, url.fileURLToPath(location));
      }
      return { format: location.endsWith(".cts") ? "commonjs" : "module", source, shortCircuit: true };
    }
  });
}
` +
  extensionRPCBootstrap +
  String.raw`
(async () => {
const constructors = [];
try {
  const packageFile = moduleAPI.findPackageJSON?.("@cybros/agent", workerData.entry);
  const metadata = packageFile ? JSON.parse(fs.readFileSync(packageFile, "utf8")) : undefined;
  const exported = metadata?.exports?.["."];
  const entry = typeof exported === "string" ? exported : exported?.import;
  const location = entry ? new URL(entry, url.pathToFileURL(packageFile)).href
    : process.versions.bun ? url.pathToFileURL(Bun.resolveSync("@cybros/agent", require("node:path").dirname(url.fileURLToPath(workerData.entry)))).href
    : undefined;
  if (location) {
    const sdk = await import(location);
    for (const [name, value] of Object.entries(sdk)) if (typeof value === "function" && value.prototype instanceof Error) constructors.push([name, value]);
  }
} catch (error) {
  if (!["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(error?.code)) throw error;
}
const rpc = createExtensionRPC(parentPort, constructors);
const publicAPI = rpc.root.api;
transpile = rpc.root.transpile;
const api = {
  ...publicAPI,
  registerTool(tool) {
    publicAPI.registerTool({ ...tool, execute(input, context) {
      context.executionStarted?.();
      const result = tool.execute(input, context);
      context.started?.();
      return result;
    } });
  }
};
  const loaded = await import(workerData.entry);
  if (typeof loaded.register === "function") await loaded.register(api);
  else if (workerData.legacy && typeof loaded.default === "function") {
    const tools = await loaded.default({ directory: publicAPI.directory, signal: publicAPI.signal });
    tools.forEach(api.registerTool);
  } else throw new Error("An extension must export register(api).");
  parentPort.postMessage({ extension: "ready" });
})().catch((error) => parentPort.postMessage({ extension: "failed", message: error && error.message || String(error) }));
`

type Handler = (...args: unknown[]) => unknown
type Instance = {
  worker: Worker
  rpc: ExtensionRPC
  handlers: Map<string, Handler>
  contexts: Set<(reason: Error) => void>
  ready: Promise<void>
  retire?: Promise<void>
  status?: Promise<void>
}

/** Load a module inside a replaceable worker; the daemon owns deadlines and extension leases. */
export function workerRegistration(
  entry: string,
  options: { legacy?: boolean; cancellationGraceMs?: number; startupMs?: number } = {},
): ExtensionModule["register"] {
  return async (api) => {
    const host = new ExtensionWorker(entry, api, options)
    api.onShutdown(() => host.close())
    await host.start()
  }
}

class ExtensionWorker {
  private instance?: Instance
  private starting?: Promise<void>
  private closed = false
  private registered = false
  private readonly contributions = new Map<string, unknown>()
  private readonly shutdown = new Set<string>()
  private status = { ready: true, issues: [] as string[] }
  private readonly grace: number
  private closing?: Promise<void>
  private readonly abort = () => {
    void this.close()
  }

  constructor(
    private readonly entry: string,
    private readonly api: ExtensionAPI,
    private readonly options: { legacy?: boolean; cancellationGraceMs?: number; startupMs?: number },
  ) {
    this.grace = options.cancellationGraceMs ?? 2000
    this.api.signal.addEventListener("abort", this.abort, { once: true })
  }

  start() {
    if (this.closed) return Promise.reject(new Error("This extension has closed."))
    if (this.starting) return this.starting
    if (this.instance && !this.instance.retire) return this.instance.ready
    const pending = this.spawn()
    this.starting = pending
    void pending
      .finally(() => {
        if (this.starting === pending) this.starting = undefined
      })
      .catch(() => {})
    return pending
  }

  private async spawn() {
    const transpile = process.versions.bun ? undefined : await typescriptTransform()
    this.api.signal.throwIfAborted()
    if (this.closed) throw new Error("This extension has closed.")
    const worker = new Worker(bootstrap, {
      eval: true,
      workerData: { entry: pathToFileURL(this.entry).href, legacy: this.options.legacy ?? false },
    })
    const handlers = new Map<string, Handler>()
    const seen = new Set<string>()
    const invoke = (key: string, args: unknown[], signal?: AbortSignal, retired?: (reason: Error) => void) =>
      this.invoke(key, args, signal, retired)
    const register = (key: string, metadata: unknown, handler: Handler, install: () => void) => {
      if (seen.has(key)) throw new Error("Duplicate extension contribution: " + key)
      seen.add(key)
      if (
        this.registered &&
        (!this.contributions.has(key) || !isDeepStrictEqual(this.contributions.get(key), metadata))
      )
        throw new Error("The replacement extension changed its registered contributions: " + key)
      handlers.set(key, handler)
      if (this.registered) return
      this.contributions.set(key, metadata)
      install()
    }
    let sequence = 0
    const remote: ExtensionAPI = {
      directory: this.api.directory,
      signal: this.api.signal,
      configuration: this.api.configuration,
      application: this.api.application,
      configure: this.api.configure,
      announced: this.api.announced,
      registerWebUI: async (root) => {
        const key = "webui"
        if (this.registered && this.contributions.get(key) !== root)
          throw new Error("The replacement extension changed its UI directory.")
        seen.add(key)
        if (this.registered) return
        this.contributions.set(key, root)
        await this.api.registerWebUI(root)
      },
      registerTool: (tool: RunnerTool) => {
        const key = "tool:" + (tool.role ?? "runner") + ":" + tool.definition.name
        const metadata = {
          definition: tool.definition,
          role: tool.role,
          resource: tool.resource,
          internalTimeout: tool.internalTimeout,
        }
        register(
          key,
          metadata,
          (input, context) => tool.execute(input as Parameters<RunnerTool["execute"]>[0], context as RunnerContext),
          () =>
            this.api.registerTool({
              ...tool,
              isolated: true,
              execute: (input, context) =>
                invoke(key, [input, context], context.signal, context.workerRetired) as ReturnType<
                  RunnerTool["execute"]
                >,
            }),
        )
      },
      registerCommand: (name, handler) => {
        const key = "command:" + name
        register(key, name, handler as Handler, () =>
          this.api.registerCommand(
            name,
            (input) => invoke(key, [input], this.api.signal) as ReturnType<typeof handler>,
          ),
        )
      },
      registerDocument: (document: ExtensionDocument) => {
        const key = "document:" + document.role + ":" + document.name
        register(
          key,
          { name: document.name, description: document.description, role: document.role },
          document.load as Handler,
          () =>
            this.api.registerDocument({
              ...document,
              load: (context) => invoke(key, [context], context.signal) as ReturnType<ExtensionDocument["load"]>,
            }),
        )
      },
      on: (event, handler) => {
        const key = "hook:" + event + ":" + sequence++
        register(key, event, handler as Handler, () =>
          this.api.on(event, (value) => invoke(key, [value], this.api.signal)),
        )
      },
      onShutdown: (handler) => {
        const key = "shutdown:" + sequence++
        register(key, key, handler, () => {
          this.shutdown.add(key)
        })
      },
      describeEnvironment: (handler) => {
        const key = "environment:" + sequence++
        register(key, key, handler as Handler, () =>
          this.api.describeEnvironment(
            (environment) => invoke(key, [environment], this.api.signal) as Promise<string | undefined>,
          ),
        )
      },
      onToolResult: (handler) => {
        const key = "result:" + sequence++
        register(key, key, handler as Handler, () =>
          this.api.onToolResult(
            (context, result) => invoke(key, [context, result], this.api.signal) as ReturnType<typeof handler>,
          ),
        )
      },
      describeStatus: (handler) => {
        const key = "status:" + sequence++
        register(key, key, handler, () => this.api.describeStatus(() => this.status))
      },
    }
    const rpc = new ExtensionRPC(worker, { api: remote, transpile })
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Extension registration timed out."))
        void this.retire(instance, new Error("Extension registration timed out."))
      }, this.options.startupMs ?? 30_000)
      worker.on("message", (message: unknown) => {
        if (!message || typeof message !== "object" || !("extension" in message)) return
        if (message.extension === "ready") {
          if (this.registered && seen.size !== this.contributions.size) {
            reject(new Error("The replacement extension omitted registered contributions."))
            return
          }
          this.registered = true
          this.status = { ready: true, issues: [] }
          void this.refreshStatus(instance).then(() => {
            clearTimeout(timeout)
            resolve()
          }, reject)
        }
        if (message.extension === "failed") {
          clearTimeout(timeout)
          reject(
            new Error(
              "message" in message && typeof message.message === "string"
                ? message.message
                : "Extension registration failed.",
            ),
          )
        }
      })
      worker.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
        void this.retire(instance, error)
      })
      worker.once("exit", (code) => {
        clearTimeout(timeout)
        const error = new Error("Extension worker exited (" + code + ").")
        reject(error)
        if (!instance.retire) void this.retire(instance, error)
      })
    })
    const instance: Instance = { worker, rpc, handlers, ready, contexts: new Set() }
    this.instance = instance
    if (this.api.signal.aborted) this.abort()
    await ready.catch(async (error: unknown) => {
      await this.retire(instance, error instanceof Error ? error : new Error(String(error)))
      throw error
    })
  }

  private async invoke(key: string, args: unknown[], signal?: AbortSignal, retired?: (reason: Error) => void) {
    signal?.throwIfAborted()
    await this.start()
    const instance = this.instance!
    const handler = instance.handlers.get(key)
    if (!handler) throw new Error("The extension handler is unavailable: " + key)
    if (retired) instance.contexts.add(retired)
    const result = await this.watch(instance, () => handler(...args), signal).finally(() => {
      if (retired) instance.contexts.delete(retired)
    })
    if (!key.startsWith("hook:turn.follow:") || !isTurnGate(result)) return result
    return {
      ...(result.run_public_id ? { run_public_id: result.run_public_id } : {}),
      reconsider: (context) => this.watch(instance, () => result.reconsider(context), context.signal),
      cancel: () => this.watch(instance, () => result.cancel?.(), AbortSignal.timeout(this.grace)),
    } satisfies TurnGate
  }

  private async watch<T>(instance: Instance, handler: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (instance.retire) throw new Error("The extension worker owning this callback has retired.")
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      timer ??= setTimeout(() => {
        void this.retire(instance, new Error("The extension worker did not acknowledge cancellation."))
      }, this.grace)
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    try {
      return await handler()
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (instance.retire) await instance.retire
      else void this.refreshStatus(instance).catch(() => {})
    }
  }

  private refreshStatus(instance: Instance): Promise<void> {
    if (instance.retire) return instance.retire
    if (instance.status) return instance.status
    const timeout = setTimeout(() => {
      void this.retire(instance, new Error("Extension status did not respond."))
    }, this.options.startupMs ?? 30_000)
    instance.status = Promise.all(
      [...instance.handlers]
        .filter(([key]) => key.startsWith("status:"))
        .map(async ([, handler]) => {
          const result = await Promise.resolve().then(() => handler())
          if (
            result &&
            typeof result === "object" &&
            "ready" in result &&
            typeof result.ready === "boolean" &&
            "issues" in result &&
            Array.isArray(result.issues)
          )
            this.status = {
              ready: result.ready,
              issues: result.issues.filter((issue): issue is string => typeof issue === "string"),
            }
        }),
    )
      .then(() => {})
      .finally(() => {
        clearTimeout(timeout)
        instance.status = undefined
      })
    return instance.status
  }

  private retire(instance: Instance, reason: Error) {
    if (instance.retire) return instance.retire
    this.status = { ready: false, issues: [reason.message] }
    const retired = instance.worker
      .terminate()
      .then(() => {})
      .finally(() => instance.rpc.close(reason))
    instance.retire = retired
    instance.contexts.forEach((cancel) => cancel(reason))
    return retired
  }

  close() {
    return (this.closing ??= this.shutdownWorker())
  }

  private async shutdownWorker() {
    this.closed = true
    this.api.signal.removeEventListener("abort", this.abort)
    const instance = this.instance
    if (!instance) return
    if (instance.retire) {
      await instance.retire
      return
    }
    const timeout = setTimeout(() => {
      void this.retire(instance, new Error("Extension shutdown timed out."))
    }, this.grace)
    await Promise.allSettled(
      [...this.shutdown].map((key) => Promise.resolve().then(() => instance.handlers.get(key)?.())),
    )
    clearTimeout(timeout)
    await this.retire(instance, new Error("Extension closed."))
  }
}

async function typescriptTransform() {
  const { transpileModule, ModuleKind, ScriptTarget, DiagnosticCategory, flattenDiagnosticMessageText } = await import(
    "typescript"
  )
  return (source: string, fileName: string) => {
    const result = transpileModule(source, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        target: ScriptTarget.ESNext,
        module: fileName.endsWith(".cts") ? ModuleKind.CommonJS : ModuleKind.ESNext,
      },
    })
    const errors = result.diagnostics?.filter((entry) => entry.category === DiagnosticCategory.Error)
    if (errors?.length)
      throw new Error(errors.map((entry) => flattenDiagnosticMessageText(entry.messageText, "\n")).join("\n"))
    return result.outputText
  }
}
