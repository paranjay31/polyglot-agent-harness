import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../packages/agent-core/src/index.js";
import { ProgressiveContextEngine } from "../../packages/context-engine/src/index.js";
import { ScriptedModelProvider } from "../../packages/model-gateway/src/index.js";
import { RulePolicyEngine } from "../../packages/policy/src/index.js";
import { InMemoryEventSink } from "../../packages/protocol/src/index.js";
import { LocalRepositoryKnowledgeProvider } from "../../packages/repository/src/index.js";
import { LocalSandbox, type Sandbox } from "../../packages/sandbox/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { RepositoryVerificationPlanner, ToolVerificationRunner } from "../../packages/verification/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";

describe("coding-loop integration", () => {
  it("inspects a workspace, edits precisely, verifies declared commands, and completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-loop-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "unit-test" } }));
    await writeFile(join(root, "note.txt"), "before\n");
    const local = new LocalSandbox(), commands: string[] = [];
    const sandbox: Sandbox = { readFile: local.readFile, writeFile: local.writeFile, execute: async command => { commands.push(command.argv.join(" ")); return { exitCode: 0, stdout: "verified", stderr: "", durationMs: 1 }; } };
    const tools = new ToolRegistry(); registerBuiltinTools(tools); const events = new InMemoryEventSink();
    const context = { workspace: new WorkspaceBoundary(root), sandbox, policy: new RulePolicyEngine({ edit: "allow", shell: "allow" }), knowledge: new LocalRepositoryKnowledgeProvider({ root }) };
    const runtime = new AgentRuntime(new ScriptedModelProvider([{ kind: "tool_calls", calls: [{ id: "edit", name: "edit_file", input: { path: "note.txt", oldText: "before", newText: "after" } }] }, { kind: "text", text: "Updated and verified." }]), tools, new ProgressiveContextEngine(context.knowledge), events, context, new ToolVerificationRunner(await new RepositoryVerificationPlanner(root).commands(), tools, context));
    const result = await runtime.run({ id: "integration", prompt: "Update note.txt", workspace: root });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("after\n");
    expect(result.state).toBe("completed"); expect(result.verification?.passed).toBe(true);
    expect(commands).toEqual(expect.arrayContaining(["git status --short", "npm test"]));
    expect(events.events.map(event => event.type)).toEqual(expect.arrayContaining(["plan.created", "tool.executed", "verification.completed", "agent.completed"]));
  });
});
