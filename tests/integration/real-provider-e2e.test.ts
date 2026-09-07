import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../packages/agent-core/src/index.js";
import { ProgressiveContextEngine } from "../../packages/context-engine/src/index.js";
import { DeepSeekProvider, OpenAICompatibleProvider } from "../../packages/model-gateway/src/index.js";
import type { PolicyEngine } from "../../packages/policy/src/index.js";
import { InMemoryEventSink } from "../../packages/protocol/src/index.js";
import { LocalRepositoryKnowledgeProvider } from "../../packages/repository/src/index.js";
import { LocalSandbox } from "../../packages/sandbox/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";

const enabled = process.env.AGENT_REAL_PROVIDER_E2E === "1";
const baseUrl = process.env.AGENT_MODEL_BASE_URL;
const apiKey = process.env.AGENT_MODEL_API_KEY;
const model = process.env.AGENT_MODEL;
const providerName = process.env.AGENT_MODEL_PROVIDER;

describe.runIf(enabled)("real OpenAI-compatible provider", () => {
  it("can execute a bounded, read-only repository inspection", async () => {
    expect(baseUrl, "AGENT_MODEL_BASE_URL is required").toBeTruthy();
    expect(apiKey, "AGENT_MODEL_API_KEY is required").toBeTruthy();
    expect(model, "AGENT_MODEL is required").toBeTruthy();
    const root = await mkdtemp(join(tmpdir(), "harness-real-provider-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "real-provider-fixture", scripts: { test: "echo fixture" } }));
    await writeFile(join(root, "README.md"), "This is a read-only real-provider fixture.\n");
    const tools = new ToolRegistry(); registerBuiltinTools(tools);
    const events = new InMemoryEventSink(); const knowledge = new LocalRepositoryKnowledgeProvider({ root });
    const readOnlyPolicy: PolicyEngine = { decide: request => request.permission === "read" ? "allow" : "deny" };
    const provider = providerName === "deepseek" ? new DeepSeekProvider({ baseUrl: baseUrl!, apiKey: apiKey!, model: model! }) : new OpenAICompatibleProvider({ baseUrl: baseUrl!, apiKey: apiKey!, model: model! });
    const runtime = new AgentRuntime(provider, tools, new ProgressiveContextEngine(knowledge), events, { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: readOnlyPolicy, knowledge });
    const result = await runtime.run({ id: "real-provider-e2e", prompt: "Read package.json, report its name, and do not change files or run commands.", workspace: root }, { maxTurns: 4 });
    expect(result.state).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(events.events.map(event => event.type)).toContain("model.requested");
    const permittedReadOnlyTools = new Set(["read_file", "list_directory", "git_status"]);
    expect(events.events.some(event => event.type === "tool.executed" && !permittedReadOnlyTools.has((event.data as { name?: string }).name ?? ""))).toBe(false);
  }, 120_000);
});
