import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, chmod, stat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSandbox, DockerSandbox, RemoteWorker } from "../../packages/sandbox/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { RulePolicyEngine, formatApprovalRequest } from "../../packages/policy/src/index.js";
import { RepositoryVerificationPlanner, ToolVerificationRunner } from "../../packages/verification/src/index.js";
import { AgentConfigSchema, repositoryConfigDigest, assertTrustedRepositoryConfig } from "../../packages/config/src/index.js";
import { createConfiguredRunHandler } from "../../apps/server/src/main.js";
import { acquireWorkspaceLease } from "../../packages/session/src/index.js";

const fixtures: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "harness-regression-")); fixtures.push(root); return root; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function registry() { const tools = new ToolRegistry(); registerBuiltinTools(tools); return tools; }

describe("adversarial regressions", () => {
  it("rejects option injection in read-only git_show before executing anything", async () => {
    const root = await fixture(); let executed = false;
    const sandbox = new LocalSandbox(); sandbox.execute = async () => { executed = true; throw new Error("must not execute"); };
    await expect(registry().invoke("git_show", { revision: `--output=${join(root, "output")}` }, { workspace: new WorkspaceBoundary(root), sandbox, policy: new RulePolicyEngine({ write: "deny", shell: "deny", git: "deny" }) })).rejects.toThrow("cannot begin with a dash");
    expect(executed).toBe(false);
  });
  it("rejects edited verification definitions in isolated auto mode and requires host approval", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "original" } }));
    const commands = await new RepositoryVerificationPlanner(root).commands();
    const local = new LocalSandbox(); let executions = 0;
    const sandbox = { isolated: true, readFile: local.readFile, writeFile: local.writeFile, execute: async () => { executions++; return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 0 }; } };
    const tools = registry(), context = { workspace: new WorkspaceBoundary(root), sandbox, policy: new RulePolicyEngine({ shell: "allow" }) };
    const verifier = new ToolVerificationRunner(commands, tools, context);
    expect((await verifier.verify()).passed).toBe(true);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "replacement" } }));
    expect(await verifier.verify()).toMatchObject({ passed: false, attempted: 0, skipped: 1 });
    await expect(tools.invoke("run_test", {}, context)).rejects.toThrow("Policy ask");
    expect(executions).toBe(1);
    const fresh = await new RepositoryVerificationPlanner(root).commands();
    const host = { ...context, sandbox: { ...sandbox, isolated: false } };
    expect((await new ToolVerificationRunner(fresh, tools, host).verify()).skipped).toBe(1);
    expect(executions).toBe(1);
  });
  it("requires a workspace-specific external config pin and rejects changed configuration", async () => {
    const root = await fixture(), other = await fixture();
    const config = AgentConfigSchema.parse({ mcp: [{ id: "example", transport: "stdio", command: "example-server" }] });
    await expect(assertTrustedRepositoryConfig(root, config, "")).rejects.toThrow("operator trust");
    const digest = await repositoryConfigDigest(root, config);
    await expect(assertTrustedRepositoryConfig(root, config, digest)).resolves.toBeUndefined();
    await expect(assertTrustedRepositoryConfig(other, config, digest)).rejects.toThrow("operator trust");
    config.mcp[0]!.command = "replacement";
    await expect(assertTrustedRepositoryConfig(root, config, digest)).rejects.toThrow("operator trust");
  });
  it("blocks executable repository configuration before server initialization can launch it", async () => {
    const root = await fixture(), marker = join(root, "executed");
    await mkdir(join(root, ".agent"));
    await writeFile(join(root, ".agent", "config.json"), JSON.stringify({ mcp: [{ id: "probe", transport: "stdio", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] }] }));
    await expect(createConfiguredRunHandler(root)).rejects.toThrow("operator trust");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves executable permissions during atomic edits", async () => {
    const root = await fixture(), file = join(root, "gradlew");
    await writeFile(file, "before"); await chmod(file, 0o755);
    await new LocalSandbox().writeFile(file, Buffer.from("after"));
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    expect(await readFile(file, "utf8")).toBe("after");
  });
  it("rejects unconfined remote executors", async () => {
    const root = await fixture();
    const worker = new RemoteWorker({ project: root }, new LocalSandbox());
    await expect(worker.execute("project", { argv: [process.execPath, "-e", "process.exit(0)"] })).rejects.toThrow("isolated sandbox");
  });
  it("mounts only the assigned workspace with resource limits and removes cancelled containers", async () => {
    const root = await fixture(), commands: string[][] = [], controller = new AbortController();
    const sandbox = new DockerSandbox({ workspace: root, image: "fixture" }, { execute: async command => {
      commands.push(command.argv);
      if (command.argv[1] === "run") controller.abort();
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    } });
    await sandbox.execute({ argv: ["echo", "ok"], signal: controller.signal });
    expect(commands[0]).toEqual(expect.arrayContaining(["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "none", `type=bind,src=${root},dst=/workspace`]));
    expect(commands[1]?.slice(0, 3)).toEqual(["docker", "rm", "--force"]);
    expect(commands[1]?.[3]).toBe(commands[0]?.[commands[0]!.indexOf("--name") + 1]);
  });
  it("holds exclusive workspace ownership and releases it after failures", async () => {
    const root = await fixture(); const release = await acquireWorkspaceLease([root]);
    try { await expect(acquireWorkspaceLease([root])).rejects.toThrow("already owned"); }
    finally { await release(); }
    const next = await acquireWorkspaceLease([root]); await next();
  });
  it("shows exact arguments, working directory, and edits without terminal control injection", () => {
    const prompt = formatApprovalRequest({ tool: "shell", permission: "shell", risk: "potentially_destructive", target: "npm test", input: { workspace: "/project", command: { argv: ["npm", "test", "--", "a b"] }, patch: "-before\n+after\u001b[2J" } });
    expect(prompt).toContain('"a b"'); expect(prompt).toContain("/project"); expect(prompt).toContain("-before\\n+after"); expect(prompt).not.toContain("\u001b");
  });
});

it("rechecks verification definitions after the approval prompt", async () => {
  const root = await fixture(), manifest = join(root, "package.json");
  await writeFile(manifest, JSON.stringify({ scripts: { test: "initial" } }));
  const sandbox = new LocalSandbox(); let executed = false;
  sandbox.execute = async () => { executed = true; return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }; };
  const context = { workspace: new WorkspaceBoundary(root), sandbox, policy: new RulePolicyEngine({ shell: "allow" }), approve: async () => { await writeFile(manifest, JSON.stringify({ scripts: { test: "changed during approval" } })); return true; } };
  await expect(registry().invoke("run_test", {}, context)).rejects.toThrow("changed during authorization");
  expect(executed).toBe(false);
});
