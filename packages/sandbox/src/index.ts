import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, unlink, stat, chmod } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { ExecutionUnconfirmedError, type Command, type ExecutionResult } from "../../shared/src/index.js";
import { WorkspaceBoundary } from "../../workspace/src/index.js";
export interface Sandbox { readonly isolated?: boolean; execute(command: Command): Promise<ExecutionResult>; readFile(path: string): Promise<Buffer>; writeFile(path: string, content: Buffer): Promise<void> }
export class LocalSandbox implements Sandbox {
  readonly isolated = false;
  async execute(command: Command): Promise<ExecutionResult> {
    command.signal?.throwIfAborted();
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), { cwd: command.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", failure = "", bytes = 0;
      const kill = () => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ } };
      const cancel = () => { failure = "Cancelled"; kill(); };
      const timer = setTimeout(() => { failure = "Command timed out"; kill(); }, command.timeoutMs ?? 120_000);
      command.signal?.addEventListener("abort", cancel, { once: true });
      if (command.signal?.aborted) cancel();
      const collect = (chunk: Buffer, error: boolean) => { bytes += chunk.length; if (bytes > 1_048_576) { failure = "Command output exceeded 1 MB"; kill(); return; } if (error) stderr += chunk.toString(); else stdout += chunk.toString(); };
      child.stdout.on("data", chunk => collect(chunk, false)); child.stderr.on("data", chunk => collect(chunk, true));
      child.on("error", error => { failure = error.message; });
      // A command cannot leave background descendants behind after its leader exits.
      child.on("exit", kill);
      child.on("close", code => { clearTimeout(timer); command.signal?.removeEventListener("abort", cancel); resolve({ exitCode: failure ? 1 : code ?? 1, stdout, stderr: stderr + (failure ? `\n${failure}` : ""), durationMs: Date.now() - started }); });
    });
  }
  readFile = readFile;
  async writeFile(path: string, content: Buffer) { const directory = dirname(path), temporary = `${directory}/.${randomUUID()}.agent-write`; try { await mkdir(directory, { recursive: true }); const mode = await stat(path).then(info => info.mode & 0o777).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return 0o600; throw error; }); await writeFile(temporary, content, { mode }); await chmod(temporary, mode); await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; } }
}
export interface ContainerSandboxOptions { workspace: string; image: string; network?: "none" | "bridge"; readOnlyWorkspace?: boolean; runtime?: "docker" | "podman" }
/** Containerizes command execution while leaving file I/O explicit in the host workspace interface. */
export class ContainerSandbox implements Sandbox {
  get isolated() { return (this.options.network ?? "none") === "none"; }
  constructor(private readonly options: ContainerSandboxOptions, private readonly runner: Pick<Sandbox, "execute"> = new LocalSandbox()) { if (!options.image || options.image.startsWith("-")) throw new Error("Invalid container image"); }
  private insidePath(path: string) { const inside = relative(this.options.workspace, path); if (!inside || inside === "." || inside.startsWith("..") || /^(?:\/|\\)/.test(inside)) throw new Error("Container file path escapes workspace"); return `/workspace/${inside.replaceAll("\\", "/")}`; }
  private async run(argv: string[], cwd = this.options.workspace, timeoutMs?: number, signal?: AbortSignal): Promise<ExecutionResult> {
    const inside = relative(this.options.workspace, cwd);
    if (inside.startsWith("..") || /^(?:\/|\\)/.test(inside)) throw new Error("Container command cwd escapes workspace");
    const workdir = inside && inside !== "." ? `/workspace/${inside.replaceAll("\\", "/")}` : "/workspace";
    const runtime = this.options.runtime ?? "docker", name = `agent-${randomUUID()}`;
    let result: ExecutionResult | undefined;
    try { result = await this.runner.execute({ argv: [runtime, "run", "--rm", "--name", name, "--network", this.options.network ?? "none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1g", "--cpus=2", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--user", `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`, "--mount", `type=bind,src=${this.options.workspace},dst=/workspace${this.options.readOnlyWorkspace ? ",readonly" : ""}`, "--workdir", workdir, this.options.image, ...argv], timeoutMs, signal }); return result; }
    finally {
      if (signal?.aborted || result?.exitCode !== 0) {
        const cleanup = await this.runner.execute({ argv: [runtime, "rm", "--force", name], timeoutMs: 30_000 });
        if (cleanup.exitCode !== 0 && !/no such (container|object)/i.test(cleanup.stderr)) throw new ExecutionUnconfirmedError(`Cannot confirm termination of container ${name}: ${cleanup.stderr}`);
      }
    }
  }
  execute(command: Command) { return this.run(command.argv, command.cwd, command.timeoutMs, command.signal); }
  async readFile(path: string) { const result = await this.run(["cat", "--", this.insidePath(path)]); if (result.exitCode !== 0) throw new Error(result.stderr || `Unable to read ${path}`); return Buffer.from(result.stdout); }
  async writeFile(path: string, content: Buffer) { if (this.options.readOnlyWorkspace) throw new Error("Container workspace is read-only"); const target = this.insidePath(path); const temporary = `${target}.${randomUUID()}.agent-write`; const encoded = content.toString("base64"); const result = await this.run(["sh", "-c", "umask 077; mkdir -p \"$(dirname \"$3\")\" && printf %s \"$1\" | base64 -d > \"$2\" && { if [ -e \"$3\" ]; then chmod --reference=\"$3\" \"$2\"; fi; } && mv \"$2\" \"$3\"", "agent-write", encoded, temporary, target]); if (result.exitCode !== 0) throw new Error(result.stderr || `Unable to write ${path}`); }
}
export class DockerSandbox extends ContainerSandbox { constructor(options: Omit<ContainerSandboxOptions, "runtime">, runner?: Pick<Sandbox, "execute">) { super({ ...options, runtime: "docker" }, runner); } }
export class PodmanSandbox extends ContainerSandbox { constructor(options: Omit<ContainerSandboxOptions, "runtime">, runner?: Pick<Sandbox, "execute">) { super({ ...options, runtime: "podman" }, runner); } }
export interface RemoteExecutor {
  execute(request: { workspaceId: string; command: Command }): Promise<ExecutionResult>;
  readFile(request: { workspaceId: string; path: string }): Promise<Buffer>;
  writeFile(request: { workspaceId: string; path: string; content: Buffer }): Promise<void>;
}
/** Transport-neutral boundary for a trusted remote worker; authorization stays in ToolRegistry/PolicyEngine. */
export class RemoteSandbox implements Sandbox {
  readonly isolated = true;
  constructor(private readonly workspaceId: string, private readonly remote: RemoteExecutor, private readonly workspaceRoot?: string) {}
  private remotePath(path: string) {
    if (!this.workspaceRoot) return path;
    const value = relative(this.workspaceRoot, path);
    if (value.startsWith("..") || /^(?:\/|\\)/.test(value)) throw new Error("Remote sandbox path escapes configured workspace");
    return value.replaceAll("\\", "/") || ".";
  }
  async execute(command: Command) { return this.remote.execute({ workspaceId: this.workspaceId, command: { ...command, ...(command.cwd ? { cwd: this.remotePath(command.cwd) } : {}) } }); }
  async readFile(path: string) { return this.remote.readFile({ workspaceId: this.workspaceId, path: this.remotePath(path) }); }
  async writeFile(path: string, content: Buffer) { return this.remote.writeFile({ workspaceId: this.workspaceId, path: this.remotePath(path), content }); }
}

export interface HttpRemoteExecutorOptions {
  endpoint: string;
  bearerToken?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Client for a trusted remote worker. The worker must authenticate the caller,
 * authorize the workspace ID, and confine the supplied paths to that workspace.
 */
export class HttpRemoteExecutor implements RemoteExecutor {
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: HttpRemoteExecutorOptions) { this.fetcher = options.fetch ?? globalThis.fetch; }
  private async request<T>(workspaceId: string, operation: "execute" | "read" | "write" | "cancel", body: object, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    let response: Response;
    try { response = await this.fetcher(`${this.options.endpoint.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(workspaceId)}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}) },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    }); } catch (error) { if (controller.signal.aborted) throw new Error(`Remote worker ${operation} timed out`); throw error; } finally { clearTimeout(timer); }
    const result = await response.json().catch(() => ({})) as { error?: string; code?: string } & T;
    if (result.code === "EXECUTION_UNCONFIRMED") throw new ExecutionUnconfirmedError(result.error ?? "Remote execution termination is unconfirmed");
    if (!response.ok) throw new Error(result.error ?? `Remote worker request failed (${response.status})`);
    return result;
  }
  async execute({ workspaceId, command }: { workspaceId: string; command: Command }) {
    command.signal?.throwIfAborted();
    const operationId = randomUUID();
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => { cancellation ??= this.request(workspaceId, "cancel", { operationId }).catch(error => { throw new ExecutionUnconfirmedError(`Remote cancellation could not be confirmed: ${String(error)}`); }); void cancellation.catch(() => {}); };
    command.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (command.signal?.aborted) cancel();
      // Keep the execution response open: cancellation acknowledges process termination.
      const result = await this.request<ExecutionResult>(workspaceId, "execute", { operationId, command: { ...command, signal: undefined } });
      await cancellation;
      if (typeof result.exitCode !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.durationMs !== "number") throw new Error("Remote worker returned an invalid execution result");
      return result;
    } catch (error) { cancel(); await cancellation; throw error; }
    finally { command.signal?.removeEventListener("abort", cancel); }
  }
  async readFile({ workspaceId, path }: { workspaceId: string; path: string }) {
    const result = await this.request<{ contentBase64?: string }>(workspaceId, "read", { path });
    if (typeof result.contentBase64 !== "string") throw new Error("Remote worker returned invalid file content");
    return Buffer.from(result.contentBase64, "base64");
  }
  async writeFile({ workspaceId, path, content }: { workspaceId: string; path: string; content: Buffer }) {
    await this.request<Record<string, never>>(workspaceId, "write", { path, contentBase64: content.toString("base64") });
  }
}

/** Trusted worker-side implementation. It maps opaque workspace IDs to local confined roots. */
export class RemoteWorker {
  private readonly workspaces: Map<string, WorkspaceBoundary>;
  constructor(roots: Record<string, string>, private readonly executor: Sandbox | ((root: string) => Sandbox) = root => new DockerSandbox({ workspace: root, image: "node:20" })) { this.workspaces = new Map(Object.entries(roots).map(([id, root]) => [id, new WorkspaceBoundary(root)])); }
  private workspace(id: string) { const boundary = this.workspaces.get(id); if (!boundary) throw new Error("Unknown remote workspace"); return boundary; }
  async execute(workspaceId: string, command: Command) { if (!command || !Array.isArray(command.argv) || !command.argv.length || !command.argv.every(argument => typeof argument === "string")) throw new Error("Invalid command"); if (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 600_000)) throw new Error("Invalid command timeout"); const workspace = this.workspace(workspaceId), cwd = await workspace.resolveUserPath(command.cwd ?? "."); const sandbox = typeof this.executor === "function" ? this.executor(workspace.root) : this.executor; if (!sandbox.isolated) throw new Error("Remote commands require an isolated sandbox"); return sandbox.execute({ ...command, cwd }); }
  async readFile(workspaceId: string, path: string) { return new LocalSandbox().readFile(await this.workspace(workspaceId).resolveUserPath(path)); }
  async writeFile(workspaceId: string, path: string, content: Buffer) { await new LocalSandbox().writeFile(await this.workspace(workspaceId).resolveUserPath(path), content); }
}

export function createRemoteWorkerServer(worker: RemoteWorker, apiKey: string): Server {
  if (!apiKey) throw new Error("Remote worker requires an API key");
  const operations = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const cancelled = new Map<string, number>();
  const unconfirmed = new Map<string, string>();
  const reply = (response: any, status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  return createServer(async (request, response) => { try {
    if (request.method !== "POST") return reply(response, 404, { error: "Not found" });
    if (request.headers.authorization !== `Bearer ${apiKey}`) return reply(response, 401, { error: "Unauthorized" });
    const match = request.url?.match(/^\/v1\/workspaces\/([^/]+)\/(execute|read|write|cancel)$/); if (!match) return reply(response, 404, { error: "Not found" });
    const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (bytes > 10_000_000) throw new Error("Request body exceeds 10 MB"); chunks.push(chunk); } const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { command?: Command; path?: string; contentBase64?: string; operationId?: string };
    const workspaceId = decodeURIComponent(match[1]!), operation = match[2]!;
    if ((operation === "execute" && body.operationId !== undefined) || operation === "cancel") {
      if (typeof body.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(body.operationId)) throw new Error("Invalid operationId");
    }
    const key = `${workspaceId}:${body.operationId}`;
    if (operation === "cancel") {
      if (unconfirmed.has(key)) throw new ExecutionUnconfirmedError(unconfirmed.get(key)!);
      for (const [id, expires] of cancelled) if (expires < Date.now()) cancelled.delete(id);
      const active = operations.get(key);
      if (active) { active.controller.abort(); await active.done; if (unconfirmed.has(key)) throw new ExecutionUnconfirmedError(unconfirmed.get(key)!); }
      else { if (cancelled.size >= 1_000) throw new Error("Too many cancellation requests"); cancelled.set(key, Date.now() + 600_000); }
      return reply(response, 200, { cancelled: true });
    }
    if (operation === "execute") {
      if (operations.has(key)) throw new Error("Operation already active");
      const controller = new AbortController();
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      operations.set(key, { controller, done });
      if (cancelled.delete(key)) controller.abort();
      const cancel = () => { if (!response.writableEnded) controller.abort(); };
      response.on("close", cancel);
      try { return reply(response, 200, await worker.execute(workspaceId, { ...body.command!, signal: controller.signal })); }
      catch (error) { if (error instanceof ExecutionUnconfirmedError) unconfirmed.set(key, error.message); throw error; }
      finally { response.removeListener("close", cancel); operations.delete(key); finish(); }
    }
    if (typeof body.path !== "string") throw new Error("path is required");
    if (operation === "read") return reply(response, 200, { contentBase64: (await worker.readFile(workspaceId, body.path)).toString("base64") });
    if (typeof body.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.contentBase64) || body.contentBase64.length % 4 !== 0) throw new Error("Invalid base64 content");
    await worker.writeFile(workspaceId, body.path, Buffer.from(body.contentBase64, "base64")); return reply(response, 200, {});
  } catch (error) { return reply(response, 400, { error: error instanceof Error ? error.message : "Bad request", ...(error instanceof ExecutionUnconfirmedError ? { code: error.code } : {}) }); } });
}
