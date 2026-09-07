import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Command, ExecutionResult } from "../../shared/src/index.js";
import { WorkspaceBoundary } from "../../workspace/src/index.js";
const execFileAsync = promisify(execFile);
export interface Sandbox { execute(command: Command): Promise<ExecutionResult>; readFile(path: string): Promise<Buffer>; writeFile(path: string, content: Buffer): Promise<void> }
export class LocalSandbox implements Sandbox {
  async execute(command: Command): Promise<ExecutionResult> { const started = Date.now(); try { const { stdout, stderr } = await execFileAsync(command.argv[0]!, command.argv.slice(1), { cwd: command.cwd, timeout: command.timeoutMs ?? 120_000 }); return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started }; } catch (error: any) { return { exitCode: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, durationMs: Date.now() - started }; } }
  readFile = readFile;
  async writeFile(path: string, content: Buffer) { const directory = dirname(path), temporary = `${directory}/.${randomUUID()}.agent-write`; try { await mkdir(directory, { recursive: true }); await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; } }
}
export interface ContainerSandboxOptions { workspace: string; image: string; network?: "none" | "bridge"; readOnlyWorkspace?: boolean; runtime?: "docker" | "podman" }
/** Containerizes command execution while leaving file I/O explicit in the host workspace interface. */
export class ContainerSandbox implements Sandbox {
  constructor(private readonly options: ContainerSandboxOptions, private readonly runner: Pick<Sandbox, "execute"> = new LocalSandbox()) {}
  private insidePath(path: string) { const inside = relative(this.options.workspace, path); if (!inside || inside === "." || inside.startsWith("..") || /^(?:\/|\\)/.test(inside)) throw new Error("Container file path escapes workspace"); return `/workspace/${inside.replaceAll("\\", "/")}`; }
  private async run(argv: string[], cwd = this.options.workspace, timeoutMs?: number): Promise<ExecutionResult> { const inside = relative(this.options.workspace, cwd); if (inside.startsWith("..") || /^(?:\/|\\)/.test(inside)) throw new Error("Container command cwd escapes workspace"); const workdir = inside && inside !== "." ? `/workspace/${inside.replaceAll("\\", "/")}` : "/workspace"; return this.runner.execute({ argv: [this.options.runtime ?? "docker", "run", "--rm", "--network", this.options.network ?? "none", "--mount", `type=bind,src=${this.options.workspace},dst=/workspace${this.options.readOnlyWorkspace ? ",readonly" : ""}`, "--workdir", workdir, this.options.image, ...argv], timeoutMs }); }
  execute(command: Command) { return this.run(command.argv, command.cwd, command.timeoutMs); }
  async readFile(path: string) { const result = await this.run(["cat", "--", this.insidePath(path)]); if (result.exitCode !== 0) throw new Error(result.stderr || `Unable to read ${path}`); return Buffer.from(result.stdout); }
  async writeFile(path: string, content: Buffer) { if (this.options.readOnlyWorkspace) throw new Error("Container workspace is read-only"); const target = this.insidePath(path); const temporary = `${target}.agent-write`; const encoded = content.toString("base64"); const result = await this.run(["sh", "-c", "umask 077; mkdir -p \"$(dirname \"$3\")\" && printf %s \"$1\" | base64 -d > \"$2\" && mv \"$2\" \"$3\"", "agent-write", encoded, temporary, target]); if (result.exitCode !== 0) throw new Error(result.stderr || `Unable to write ${path}`); }
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
  constructor(private readonly workspaceId: string, private readonly remote: RemoteExecutor, private readonly workspaceRoot?: string) {}
  private remotePath(path: string) {
    if (!this.workspaceRoot) return path;
    const value = relative(this.workspaceRoot, path);
    if (value.startsWith("..") || /^(?:\/|\\)/.test(value)) throw new Error("Remote sandbox path escapes configured workspace");
    return value || ".";
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
  private async request<T>(workspaceId: string, operation: "execute" | "read" | "write", body: object): Promise<T> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    let response: Response;
    try { response = await this.fetcher(`${this.options.endpoint.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(workspaceId)}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}) },
      body: JSON.stringify(body), signal: controller.signal
    }); } catch (error) { if (controller.signal.aborted) throw new Error(`Remote worker ${operation} timed out`); throw error; } finally { clearTimeout(timer); }
    const result = await response.json().catch(() => ({})) as { error?: string } & T;
    if (!response.ok) throw new Error(result.error ?? `Remote worker request failed (${response.status})`);
    return result;
  }
  async execute({ workspaceId, command }: { workspaceId: string; command: Command }) {
    const result = await this.request<ExecutionResult>(workspaceId, "execute", { command });
    if (typeof result.exitCode !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.durationMs !== "number") throw new Error("Remote worker returned an invalid execution result");
    return result;
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
  constructor(roots: Record<string, string>, private readonly sandbox: Sandbox = new LocalSandbox()) { this.workspaces = new Map(Object.entries(roots).map(([id, root]) => [id, new WorkspaceBoundary(root)])); }
  private workspace(id: string) { const boundary = this.workspaces.get(id); if (!boundary) throw new Error("Unknown remote workspace"); return boundary; }
  async execute(workspaceId: string, command: Command) { if (!Array.isArray(command.argv) || !command.argv.length || !command.argv.every(argument => typeof argument === "string")) throw new Error("Invalid command"); const workspace = this.workspace(workspaceId), cwd = await workspace.resolveUserPath(command.cwd ?? "."); return this.sandbox.execute({ ...command, cwd }); }
  async readFile(workspaceId: string, path: string) { return this.sandbox.readFile(await this.workspace(workspaceId).resolveUserPath(path)); }
  async writeFile(workspaceId: string, path: string, content: Buffer) { await this.sandbox.writeFile(await this.workspace(workspaceId).resolveUserPath(path), content); }
}

export function createRemoteWorkerServer(worker: RemoteWorker, apiKey: string): Server {
  if (!apiKey) throw new Error("Remote worker requires an API key");
  const reply = (response: any, status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  return createServer(async (request, response) => { try {
    if (request.method !== "POST") return reply(response, 404, { error: "Not found" });
    if (request.headers.authorization !== `Bearer ${apiKey}`) return reply(response, 401, { error: "Unauthorized" });
    const match = request.url?.match(/^\/v1\/workspaces\/([^/]+)\/(execute|read|write)$/); if (!match) return reply(response, 404, { error: "Not found" });
    const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (bytes > 10_000_000) throw new Error("Request body exceeds 10 MB"); chunks.push(chunk); } const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { command?: Command; path?: string; contentBase64?: string };
    const workspaceId = decodeURIComponent(match[1]!), operation = match[2]!;
    if (operation === "execute") return reply(response, 200, await worker.execute(workspaceId, body.command as Command));
    if (typeof body.path !== "string") throw new Error("path is required");
    if (operation === "read") return reply(response, 200, { contentBase64: (await worker.readFile(workspaceId, body.path)).toString("base64") });
    if (typeof body.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.contentBase64) || body.contentBase64.length % 4 !== 0) throw new Error("Invalid base64 content");
    await worker.writeFile(workspaceId, body.path, Buffer.from(body.contentBase64, "base64")); return reply(response, 200, {});
  } catch (error) { return reply(response, 400, { error: error instanceof Error ? error.message : "Bad request" }); } });
}
