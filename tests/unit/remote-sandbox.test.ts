import { describe, expect, it } from "vitest";
import { HttpRemoteExecutor, RemoteSandbox, RemoteWorker } from "../../packages/sandbox/src/index.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("remote sandbox", () => it("forwards an explicit workspace identity to a remote executor", async () => { const requests: unknown[] = []; const sandbox = new RemoteSandbox("worker-42", { execute: async request => { requests.push(request); return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }; }, readFile: async request => { requests.push(request); return Buffer.from("data"); }, writeFile: async request => { requests.push(request); } }); expect((await sandbox.execute({ argv: ["git", "status"] })).stdout).toBe("ok"); expect((await sandbox.readFile("/workspace/a.ts")).toString()).toBe("data"); await sandbox.writeFile("/workspace/a.ts", Buffer.from("next")); expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId: "worker-42" })])); }));

it("converts local paths to confined worker-relative paths", async () => {
  const requests: Array<{ path?: string; command?: { cwd?: string } }> = [];
  const sandbox = new RemoteSandbox("worker-42", { execute: async request => { requests.push(request); return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }; }, readFile: async request => { requests.push(request); return Buffer.from(""); }, writeFile: async request => { requests.push(request); } }, "/source/repo");
  await sandbox.execute({ argv: ["git", "status"], cwd: "/source/repo/packages/a" });
  await sandbox.readFile("/source/repo/src/a.ts");
  expect(requests).toEqual([{ command: { argv: ["git", "status"], cwd: "packages/a" }, workspaceId: "worker-42" }, { path: "src/a.ts", workspaceId: "worker-42" }]);
  await expect(sandbox.readFile("/outside/secret")).rejects.toThrow("escapes configured workspace");
});

describe("HTTP remote executor", () => it("uses an authenticated, workspace-scoped protocol", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const operation = String(url).split("/").at(-1);
    const body = operation === "execute" ? { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 } : operation === "read" ? { contentBase64: Buffer.from("remote").toString("base64") } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const remote = new HttpRemoteExecutor({ endpoint: "https://worker.example/", bearerToken: "token", fetch });
  expect((await remote.execute({ workspaceId: "repo A", command: { argv: ["git", "status"] } })).stdout).toBe("ok");
  expect((await remote.readFile({ workspaceId: "repo A", path: "src/a.ts" })).toString()).toBe("remote");
  await remote.writeFile({ workspaceId: "repo A", path: "src/a.ts", content: Buffer.from("next") });
  expect(calls).toHaveLength(3);
  expect(calls[0]?.url).toBe("https://worker.example/v1/workspaces/repo%20A/execute");
  expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer token" });
  expect(calls[2]?.init?.body).toBe(JSON.stringify({ path: "src/a.ts", contentBase64: "bmV4dA==" }));
}));

it("bounds an unresponsive remote worker request", async () => { const fetch = async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })); const remote = new HttpRemoteExecutor({ endpoint: "https://worker.example", fetch, timeoutMs: 10 }); await expect(remote.readFile({ workspaceId: "project", path: "src/a.ts" })).rejects.toThrow("Remote worker read timed out"); });

describe("remote worker", () => it("maps opaque workspace IDs to confined local roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-")); await writeFile(join(root, "note.txt"), "before");
  const worker = new RemoteWorker({ project: root });
  expect((await worker.readFile("project", "note.txt")).toString()).toBe("before");
  await worker.writeFile("project", "note.txt", Buffer.from("after"));
  expect(await readFile(join(root, "note.txt"), "utf8")).toBe("after");
  await expect(worker.readFile("project", "../outside")).rejects.toThrow("escapes workspace");
  await expect(worker.writeFile("project", ".env", Buffer.from("secret"))).rejects.toThrow("Protected secret");
  await expect(worker.readFile("unknown", "note.txt")).rejects.toThrow("Unknown remote workspace");
}));

it("confines remote command working directories before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-command-")); const commands: Array<{ cwd?: string }> = [];
  const worker = new RemoteWorker({ project: root }, { isolated: true, execute: async command => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }; }, readFile: async () => Buffer.alloc(0), writeFile: async () => {} });
  await worker.execute("project", { argv: ["git", "status"], cwd: "." });
  expect(commands).toEqual([expect.objectContaining({ cwd: root })]);
  await expect(worker.execute("project", { argv: ["git", "status"], cwd: "../outside" })).rejects.toThrow("escapes workspace");
  await expect(worker.execute("project", { argv: ["git", "status"], cwd: ".git" })).rejects.toThrow("Git internals");
});
