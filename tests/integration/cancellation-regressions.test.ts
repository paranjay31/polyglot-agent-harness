import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSandbox } from "../../packages/sandbox/src/index.js";
import { AgentRuntime } from "../../packages/agent-core/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { ScriptedModelProvider } from "../../packages/model-gateway/src/index.js";
import { RulePolicyEngine } from "../../packages/policy/src/index.js";
import { InMemoryEventSink } from "../../packages/protocol/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";
import { ProgressiveContextEngine } from "../../packages/context-engine/src/index.js";
import { LocalRepositoryKnowledgeProvider } from "../../packages/repository/src/index.js";
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "harness-cancel-regression-")); fixtures.push(root);
  const tools = new ToolRegistry(); registerBuiltinTools(tools);
  const events = new InMemoryEventSink();
  const context = { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: new RulePolicyEngine(), approve: async () => true };
  return { root, tools, events, context, engine: new ProgressiveContextEngine(new LocalRepositoryKnowledgeProvider({ root })) };
}
it("terminates a command and its descendants before releasing cancellation", async () => {
  const { root, context } = await setup(); const controller = new AbortController();
  const marker = join(root, "late-write"), ready = join(root, "ready");
  const child = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),600)`;
  const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
  const work = context.sandbox.execute({ argv: [process.execPath, "-e", code], cwd: root, signal: controller.signal });
  await expect.poll(() => readFile(ready, "utf8").catch(() => ""), { timeout: 2000 }).toBe("ready");
  controller.abort(); expect((await work).exitCode).not.toBe(0);
  await new Promise(resolve => setTimeout(resolve, 700));
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
it("reports unverified when checks are blocked", async () => {
  const { root, tools, events, context, engine } = await setup();
  const model = new ScriptedModelProvider([{ kind: "tool_calls", calls: [{ id: "a", name: "write_file", input: { path: "a", content: "a" } }] }, { kind: "text", text: "Done" }]);
  const runtime = new AgentRuntime(model, tools, engine, events, context, { verify: async () => ({ passed: false, attempted: 0, skipped: 1, results: [] }) });
  expect((await runtime.run({ id: "a", prompt: "edit", workspace: root })).state).toBe("unverified");
  expect(events.events.some(event => event.type === "agent.completed")).toBe(false);
  expect(events.events.some(event => event.type === "agent.unverified")).toBe(true);
});
it("cancels verification instead of completing and passes the parent signal to it", async () => {
  const { root, tools, events, context, engine } = await setup(); const controller = new AbortController();
  const model = new ScriptedModelProvider([{ kind: "tool_calls", calls: [{ id: "a", name: "write_file", input: { path: "a", content: "a" } }] }, { kind: "text", text: "Done" }]);
  const runtime = new AgentRuntime(model, tools, engine, events, context, { verify: async signal => { expect(signal).toBe(controller.signal); controller.abort(); signal?.throwIfAborted(); throw new Error("unreachable"); } });
  expect((await runtime.run({ id: "a", prompt: "edit", workspace: root }, { signal: controller.signal })).state).toBe("cancelled");
  expect(events.events.some(event => event.type === "agent.completed")).toBe(false);
});
it("propagates parent cancellation into delegated model requests", async () => {
  const { root, tools, events, context, engine } = await setup(); const controller = new AbortController(); let childSignal: AbortSignal | undefined;
  const model = { id: "cancel-child", capabilities: new ScriptedModelProvider([]).capabilities, generate: async (request: any): Promise<any> => {
    if (!childSignal && !request.messages.some((message: any) => message.content.includes("[explorer]"))) return { kind: "tool_calls", calls: [{ id: "d", name: "delegate", input: { role: "explorer", prompt: "inspect" } }] };
    childSignal = request.signal; controller.abort(); return { kind: "text", text: "stopped" };
  } };
  const result = await new AgentRuntime(model, tools, engine, events, context).run({ id: "a", prompt: "delegate", workspace: root }, { signal: controller.signal });
  expect(childSignal?.aborted).toBe(true); expect(result.state).toBe("cancelled");
});

it("reports failure instead of cancellation when termination cannot be confirmed", async () => {
  const { ExecutionUnconfirmedError } = await import("../../packages/shared/src/index.js");
  const { root, tools, events, context, engine } = await setup(); const controller = new AbortController();
  context.sandbox.execute = async command => {
    if (command.argv[0] === "git") return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    controller.abort(); throw new ExecutionUnconfirmedError("worker unreachable; termination unconfirmed");
  };
  const model = new ScriptedModelProvider([{ kind: "tool_calls", calls: [{ id: "a", name: "shell", input: { command: { argv: ["fixture"] } } }] }]);
  const result = await new AgentRuntime(model, tools, engine, events, context).run({ id: "a", prompt: "run", workspace: root }, { signal: controller.signal });
  expect(result).toMatchObject({ state: "failed", executionUnconfirmed: true });
  expect(events.events.some(event => event.type === "agent.cancelled")).toBe(false);
});
