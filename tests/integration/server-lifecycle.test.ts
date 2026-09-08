import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createAgentServer, type AgentRunHandler, type ServerOptions } from "../../apps/server/src/index.js";
import { HttpRemoteExecutor, RemoteWorker, createRemoteWorkerServer } from "../../packages/sandbox/src/index.js";
const servers: Server[] = [], roots: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), "harness-http-")); roots.push(value); return value; }
async function listen(server: Server) { servers.push(server); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function app(handler: AgentRunHandler, options?: ServerOptions) { return listen(createAgentServer(handler, options)); }
async function post(url: string, workspace: string, sessionId: string, path = "/runs/background") { return fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "fixture", workspace, sessionId }) }); }
async function state(url: string, id: string) { return (await (await fetch(`${url}/runs/${id}`)).json() as { state: string }).state; }
it.each(["failed", "unverified", "cancelled", "completed"])("preserves nested runtime outcome %s", async outcome => {
  const url = await app({ run: async () => ({ result: { state: outcome } }) });
  expect((await post(url, await root(), "case")).status).toBe(202);
  await expect.poll(() => state(url, "case")).toBe(outcome);
});
it("keeps cancelling until execution settles, rejecting collisions and retaining active history", async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let signal: AbortSignal | undefined;
  const url = await app({ run: async request => { signal = request.signal; await waiting; return { result: { state: "cancelled" } }; } }, { maxHistory: 1, maxConcurrentRuns: 4 });
  const workspace = await root();
  try {
    expect((await post(url, workspace, "one")).status).toBe(202);
    expect((await post(url, await root(), "one")).status).toBe(409);
    expect((await post(url, workspace, "two", "/runs")).status).toBe(409);
    expect((await post(url, await root(), "three")).status).toBe(429);
    const cancelled = await fetch(`${url}/runs/one`, { method: "DELETE" });
    expect(await cancelled.json()).toMatchObject({ state: "cancelling" });
    expect(signal?.aborted).toBe(true);
    expect(await state(url, "one")).toBe("cancelling");
    expect((await post(url, workspace, "four")).status).toBe(409);
  } finally { finish(); }
  await expect.poll(() => state(url, "one")).toBe("cancelled");
  expect((await post(url, workspace, "five")).status).toBe(202);
});
it("emits failed rather than completed as the terminal SSE event", async () => {
  const url = await app({ run: async () => ({ result: { state: "failed" } }) });
  const text = await (await post(url, await root(), "stream", "/runs/stream")).text();
  expect(text).toContain("event: failed\n"); expect(text).not.toContain("event: completed\n");
});
it("waits for a remote worker cancellation acknowledgement", async () => {
  let entered = false, stopped = false;
  const worker = new RemoteWorker({ test: await root() }, { isolated: true, readFile: async () => Buffer.alloc(0), writeFile: async () => {}, execute: async command => {
    entered = true;
    await new Promise<void>(resolve => { const stop = () => setTimeout(() => { stopped = true; resolve(); }, 30); command.signal?.addEventListener("abort", stop, { once: true }); if (command.signal?.aborted) stop(); });
    return { exitCode: 1, stdout: "", stderr: "Cancelled", durationMs: 30 };
  } });
  const endpoint = await listen(createRemoteWorkerServer(worker, "fixture-token"));
  const remote = new HttpRemoteExecutor({ endpoint, bearerToken: "fixture-token" });
  const controller = new AbortController();
  const work = remote.execute({ workspaceId: "test", command: { argv: ["fixture"], signal: controller.signal } });
  await expect.poll(() => entered).toBe(true); controller.abort();
  expect((await work).exitCode).toBe(1); expect(stopped).toBe(true);
});
