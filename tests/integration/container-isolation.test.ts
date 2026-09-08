import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { RulePolicyEngine } from "../../packages/policy/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";
import { RepositoryVerificationPlanner, ToolVerificationRunner } from "../../packages/verification/src/index.js";
import { DockerSandbox, RemoteWorker } from "../../packages/sandbox/src/index.js";
const enabled = process.env.AGENT_CONTAINER_E2E === "1";
it.skipIf(!enabled)("confines real remote commands, preserves modes, and stops cancelled containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-container-e2e-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const outside = join(root, "outside.txt"); await writeFile(outside, "sentinel");
  const sandbox = new DockerSandbox({ workspace, image: process.env.AGENT_CONTAINER_IMAGE ?? "node:20-bookworm-slim" });
  const worker = new RemoteWorker({ project: workspace }, sandbox);
  try {
    const result = await worker.execute("project", { argv: ["node", "-e", `const fs=require('fs'); for(const path of ['../outside.txt',${JSON.stringify(outside)}]) { if(fs.existsSync(path)) process.exit(1); } if(process.env.AGENT_REMOTE_WORKER_TOKEN) process.exit(2); console.log('confined')`], timeoutMs: 120_000 });
    expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout).toContain("confined");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log(123)\"" } }));
    const tools = new ToolRegistry(); registerBuiltinTools(tools);
    const context = { workspace: new WorkspaceBoundary(workspace), sandbox, policy: new RulePolicyEngine({ shell: "allow" }) };
    const verifier = new ToolVerificationRunner(await new RepositoryVerificationPlanner(workspace).commands(), tools, context);
    const verified = await verifier.verify();
    expect(verified.passed, JSON.stringify(verified)).toBe(true);
    await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log(456)\"" } }));
    expect((await verifier.verify()).skipped).toBe(1);
    const file = join(workspace, "run.sh"); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755);
    await sandbox.writeFile(file, Buffer.from("#!/bin/sh\nexit 1\n"));
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    const controller = new AbortController(), marker = join(workspace, "late-write"), ready = join(workspace, "ready");
    const work = worker.execute("project", { argv: ["node", "-e", "require('fs').writeFileSync('ready','ready');setTimeout(()=>require('fs').writeFileSync('late-write','bad'),1500);setInterval(()=>{},1000)"], signal: controller.signal });
    await expect.poll(() => readFile(ready, "utf8").catch(() => ""), { timeout: 15_000 }).toBe("ready");
    controller.abort(); await work;
    await new Promise(resolve => setTimeout(resolve, 1600));
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180_000);
