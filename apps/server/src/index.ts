import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgentEvent } from "../../../packages/protocol/src/index.js";
export interface AgentRunRequest { task: string; workspace: string; maxTurns?: number; permissionMode?: "review" | "accept-edits" | "auto"; sessionId?: string; resume?: boolean; signal?: AbortSignal }
export interface AgentRunHandler { run(request: AgentRunRequest): Promise<unknown>; runStreaming?(request: AgentRunRequest, emit: (event: AgentEvent) => Promise<void>): Promise<unknown> }
export interface ServerOptions { apiKey?: string; maxRequestsPerMinute?: number; maxConcurrentRuns?: number; maxHistory?: number; now?: () => number }
type TerminalState = "completed" | "unverified" | "failed" | "cancelled";
export interface BackgroundRun { sessionId: string; state: "running" | "cancelling" | TerminalState; result?: unknown; events: AgentEvent[] }
async function jsonBody(request: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw new Error("Request body exceeds 1 MB"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
export async function parseRun(body: unknown): Promise<AgentRunRequest> {
  if (!body || typeof body !== "object") throw new Error("task and workspace are required strings");
  const input = body as Partial<AgentRunRequest>;
  if (typeof input.task !== "string" || !input.task.trim() || typeof input.workspace !== "string" || !input.workspace.trim()) throw new Error("task and workspace are required strings");
  if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 100)) throw new Error("maxTurns must be an integer from 1 to 100");
  if (input.permissionMode !== undefined && !["review", "accept-edits", "auto"].includes(input.permissionMode)) throw new Error("invalid permissionMode");
  if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId))) throw new Error("invalid sessionId");
  if (input.resume !== undefined && typeof input.resume !== "boolean") throw new Error("resume must be a boolean");
  if (input.resume && !input.sessionId) throw new Error("resume requires sessionId");
  return { task: input.task, workspace: input.workspace, maxTurns: input.maxTurns, permissionMode: input.permissionMode, sessionId: input.sessionId, resume: input.resume };
}
export async function handleRun(body: unknown, handler: AgentRunHandler) { return handler.run(await parseRun(body)); }
export function terminalState(value: unknown): TerminalState {
  const envelope = value as { result?: { state?: string }; state?: string } | undefined;
  const state = envelope?.result?.state ?? envelope?.state;
  return state === "failed" || state === "cancelled" || state === "unverified" ? state : "completed";
}
export function createAgentServer(handler: AgentRunHandler, options: ServerOptions = {}): Server {
  const hits = new Map<string, number[]>();
  const background = new Map<string, BackgroundRun & { controller: AbortController }>();
  const workspaces = new Set<string>(), sessions = new Set<string>();
  const now = options.now ?? Date.now, concurrency = options.maxConcurrentRuns ?? 4, historyLimit = options.maxHistory ?? 100;
  return createServer(async (request, response) => { try {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true });
    if (options.apiKey && request.headers.authorization !== `Bearer ${options.apiKey}`) return json(response, 401, { error: "Unauthorized" });
    const status = request.url?.match(/^\/runs\/([A-Za-z0-9_-]{1,128})$/);
    if ((request.method === "GET" || request.method === "DELETE") && status) {
      const run = background.get(status[1]!);
      if (!run) return json(response, 404, { error: "Run not found" });
      if (request.method === "DELETE") {
        if (run.state === "running") { run.state = "cancelling"; run.controller.abort(); }
        return json(response, 202, { sessionId: run.sessionId, state: run.state });
      }
      return json(response, 200, { sessionId: run.sessionId, state: run.state, result: run.result, events: run.events });
    }
    if (request.method !== "POST" || !["/runs", "/runs/stream", "/runs/background"].includes(request.url ?? "")) return json(response, 404, { error: "Not found" });
    const client = request.socket.remoteAddress ?? "unknown", cutoff = now() - 60_000;
    for (const [key, times] of hits) if (!times.some(time => time > cutoff)) hits.delete(key);
    const recent = (hits.get(client) ?? []).filter(time => time > cutoff);
    if (options.maxRequestsPerMinute && recent.length >= options.maxRequestsPerMinute) return json(response, 429, { error: "Rate limit exceeded" });
    recent.push(now()); hits.set(client, recent);
    const input = await parseRun(await jsonBody(request));
    const workspace = await realpath(input.workspace), sessionId = input.sessionId ?? randomUUID();
    if (sessions.has(sessionId) || workspaces.has(workspace)) return json(response, 409, { error: "Session or workspace already has an active run" });
    if (background.has(sessionId) && !input.resume) return json(response, 409, { error: "Session already exists; use resume" });
    if (sessions.size >= concurrency) return json(response, 429, { error: "Concurrent run limit reached" });
    const isBackground = request.url === "/runs/background";
    if (isBackground && !background.has(sessionId) && background.size >= historyLimit) {
      const oldest = [...background].find(([, run]) => run.state !== "running" && run.state !== "cancelling");
      if (!oldest) return json(response, 429, { error: "No completed history entry can be evicted" });
      background.delete(oldest[0]);
    }
    sessions.add(sessionId); workspaces.add(workspace);
    const controller = new AbortController(), run = { ...input, workspace, sessionId, signal: controller.signal };
    const release = () => { sessions.delete(sessionId); workspaces.delete(workspace); };
    if (isBackground) {
      const tracked: BackgroundRun & { controller: AbortController } = { sessionId, state: "running", events: [], controller };
      background.set(sessionId, tracked);
      void (async () => {
        try {
          tracked.result = handler.runStreaming ? await handler.runStreaming(run, async event => { if (tracked.events.length >= 1_000) tracked.events.shift(); tracked.events.push(event); }) : await handler.run(run);
          const outcome = terminalState(tracked.result); tracked.state = outcome === "failed" ? "failed" : controller.signal.aborted ? "cancelled" : outcome;
        } catch (error) { tracked.state = controller.signal.aborted ? "cancelled" : "failed"; tracked.result = { error: error instanceof Error ? error.message : String(error) }; }
        finally { release(); }
      })();
      return json(response, 202, { sessionId, state: "running" });
    }
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.on("close", cancel);
    try {
      if (request.url === "/runs") return json(response, 200, await handler.run(run));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const emit = async (event: AgentEvent) => { if (!response.destroyed) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
      const result = handler.runStreaming ? await handler.runStreaming(run, emit) : await handler.run(run);
      if (!response.destroyed) response.end(`event: ${terminalState(result)}\ndata: ${JSON.stringify(result)}\n\n`);
    } finally { response.removeListener("close", cancel); release(); }
  } catch (error) { if (!response.headersSent) return json(response, 400, { error: error instanceof Error ? error.message : "Bad request" }); response.end(); } });
}
