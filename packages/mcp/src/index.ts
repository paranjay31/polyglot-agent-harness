import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { ToolRegistry } from "../../tool-runtime/src/index.js";
import type { ToolContext, ToolResult } from "../../tool-runtime/src/index.js";

export interface McpToolDefinition { name: string; description?: string; inputSchema?: object }
export interface McpClient { id: string; listTools(): Promise<McpToolDefinition[]>; callTool(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>; close?(): Promise<void> }
export class McpToolAdapter {
  constructor(private readonly client: McpClient) {}
  async register(registry: ToolRegistry) { for (const tool of await this.client.listTools()) registry.register({ name: `mcp.${this.client.id}.${tool.name}`, description: tool.description ?? `MCP tool ${tool.name}`, modelSchema: tool.inputSchema ?? { type: "object" }, inputSchema: z.unknown(), permission: "mcp", execute: (input, context) => this.client.callTool(tool.name, input, context.signal) }); }
}
interface Pending { resolve(value: any): void; reject(reason: Error): void; timer: NodeJS.Timeout }
/** JSON-RPC over MCP's stdio Content-Length framing. */
export class StdioMcpClient implements McpClient {
  private readonly process: ChildProcessWithoutNullStreams; private readonly pending = new Map<number, Pending>(); private buffer = ""; private nextId = 1;
  constructor(readonly id: string, command: string, args: string[] = [], private readonly timeoutMs = 30_000) { this.process = spawn(command, args, { stdio: "pipe", detached: process.platform !== "win32" }); this.process.stdout.setEncoding("utf8"); this.process.stdout.on("data", chunk => this.onData(chunk)); this.process.on("error", error => this.failAll(error)); this.process.on("close", () => this.failAll(new Error(`MCP server ${id} exited`))); }
  static async connect(id: string, command: string, args: string[] = []) { const client = new StdioMcpClient(id, command, args); try { await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "polyglot-agent-harness", version: "0.1.0" } }); client.notify("notifications/initialized", {}); return client; } catch (error) { await client.close(); throw error; } }
  private onData(chunk: string) { this.buffer += chunk; while (true) { const marker = this.buffer.indexOf("\r\n\r\n"); if (marker < 0) return; const header = this.buffer.slice(0, marker); const match = header.match(/content-length:\s*(\d+)/i); if (!match) { this.buffer = ""; return; } const length = Number(match[1]); const start = marker + 4; if (this.buffer.length < start + length) return; const body = this.buffer.slice(start, start + length); this.buffer = this.buffer.slice(start + length); try { const message = JSON.parse(body); if (typeof message.id === "number") { const pending = this.pending.get(message.id); if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message ?? "MCP error")) : pending.resolve(message.result); } } } catch { /* Ignore malformed server frame and continue. */ } } }
  private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> { signal?.throwIfAborted(); const id = this.nextId++; const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }); this.process.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, this.timeoutMs); const cancel = () => { this.kill(); };
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, timer });
      signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel(); }); }
  private notify(method: string, params: unknown) { const payload = JSON.stringify({ jsonrpc: "2.0", method, params }); this.process.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`); }
  private failAll(error: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  async listTools() { const result = await this.request("tools/list", {}); return result.tools as McpToolDefinition[]; }
  async callTool(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> { const result = await this.request("tools/call", { name, arguments: input }, signal); const content = Array.isArray(result.content) ? result.content.map((item: any) => item.text ?? JSON.stringify(item)).join("\n") : JSON.stringify(result); return { content, data: result }; }
  private kill() { try { if (process.platform !== "win32" && this.process.pid) process.kill(-this.process.pid, "SIGKILL"); else this.process.kill("SIGKILL"); } catch { /* Already exited. */ } }
  async close() { if (this.process.exitCode !== null || this.process.signalCode !== null) return; await new Promise<void>(resolve => { this.process.once("close", () => resolve()); this.kill(); }); }
}
/** HTTP JSON-RPC adapter for compatible MCP gateways; streaming HTTP can implement the same McpClient interface later. */
export class HttpMcpClient implements McpClient {
  constructor(readonly id: string, private readonly endpoint: string, private readonly headers: Record<string, string> = {}) {}
  private async request(method: string, params: unknown, signal?: AbortSignal) { const response = await fetch(this.endpoint, { method: "POST", signal, headers: { "content-type": "application/json", ...this.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); if (!response.ok) throw new Error(`MCP HTTP request failed (${response.status})`); const body = await response.json() as any; if (body.error) throw new Error(body.error.message ?? "MCP error"); return body.result; }
  async listTools() { return (await this.request("tools/list", {})).tools as McpToolDefinition[]; }
  async callTool(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> { const result = await this.request("tools/call", { name, arguments: input }, signal); return { content: Array.isArray(result.content) ? result.content.map((item: any) => item.text ?? JSON.stringify(item)).join("\n") : JSON.stringify(result), data: result }; }
}
