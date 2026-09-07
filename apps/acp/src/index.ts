import type { AgentRunHandler } from "../../server/src/index.js";

export interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } }
export interface AcpOptions { workspace: string; handler: AgentRunHandler; protocolVersion?: string; notify?: (method: string, params: unknown) => Promise<void> }
/** Minimal editor transport: JSON-RPC 2.0 over newline-delimited stdio. */
export function createAcpDispatcher(options: AcpOptions) {
  return async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
    const id = request.id ?? null;
    try {
      if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: options.protocolVersion ?? "2025-01-01", serverInfo: { name: "polyglot-agent-harness", version: "0.1.0" }, capabilities: { agentRun: true, sessionReplay: true } } };
      if (request.method === "agent/run") { const params = request.params as { task?: unknown; maxTurns?: unknown; permissionMode?: unknown; sessionId?: unknown; resume?: unknown } | undefined; if (typeof params?.task !== "string" || !params.task.trim()) throw new Error("agent/run requires a non-empty task"); const run = { task: params.task, workspace: options.workspace, maxTurns: typeof params.maxTurns === "number" ? params.maxTurns : undefined, permissionMode: params.permissionMode as "review" | "accept-edits" | "auto" | undefined, sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined, resume: params.resume === true }; const result = options.handler.runStreaming ? await options.handler.runStreaming(run, event => options.notify?.("agent/event", event) ?? Promise.resolve()) : await options.handler.run(run); return { jsonrpc: "2.0", id, result }; }
      if (request.method.startsWith("notifications/")) return undefined;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    } catch (error) { return { jsonrpc: "2.0", id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } }; }
  };
}
