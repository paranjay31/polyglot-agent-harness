import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider, AzureOpenAIProvider, BedrockProvider, DeepSeekProvider, GeminiProvider, LmStudioProvider, ModelRouter, OllamaProvider, OpenAICompatibleProvider, OpenRouterProvider, PurposeModelRouter, type ModelProvider } from "../../packages/model-gateway/src/index.js";
import { AgentRuntime } from "../../packages/agent-core/src/index.js";
import { ProgressiveContextEngine } from "../../packages/context-engine/src/index.js";
import { RulePolicyEngine } from "../../packages/policy/src/index.js";
import { InMemoryEventSink } from "../../packages/protocol/src/index.js";
import { LocalRepositoryKnowledgeProvider } from "../../packages/repository/src/index.js";
import { LocalSandbox } from "../../packages/sandbox/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
describe("native model providers", () => it("normalizes Anthropic and Gemini tool calls", async () => { globalThis.fetch = vi.fn(async (url: string) => new Response(url.includes("anthropic") ? JSON.stringify({ content: [{ type: "tool_use", id: "a", name: "read_file", input: { path: "a" } }] }) : JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "b" } } }] } }] }), { status: 200 })) as typeof fetch; const request = { messages: [{ role: "user" as const, content: "read" }], tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } as any }] }; expect(await new AnthropicProvider({ apiKey: "key", model: "x", baseUrl: "https://anthropic.test" }).generate(request)).toMatchObject({ kind: "tool_calls" }); expect(await new GeminiProvider({ apiKey: "key", model: "x", baseUrl: "https://gemini.test" }).generate(request)).toMatchObject({ kind: "tool_calls" }); }));
describe("provider routing and streams", () => it("fails over and normalizes OpenAI-compatible SSE tool calls", async () => { const capabilities = { toolCalling: true, structuredOutput: false, vision: false, reasoning: false, maxContextTokens: 1 }; const broken: ModelProvider = { id: "broken", capabilities, generate: async () => { throw new Error("offline"); } }; const healthy: ModelProvider = { id: "healthy", capabilities, generate: async () => ({ kind: "text", text: "ok" }) }; await expect(new ModelRouter([broken, healthy]).generate({ messages: [{ role: "user", content: "x" }] })).resolves.toMatchObject({ text: "ok" }); const encoder = new TextEncoder(); globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a"}}]}}]}\n\n')); controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".ts\\"}"}}]}}]}\n\ndata: [DONE]\n\n')); controller.close(); } }), { status: 200 })) as typeof fetch; const chunks = []; for await (const chunk of new OpenAICompatibleProvider({ baseUrl: "https://model.test", apiKey: "key", model: "x" }).stream!({ messages: [{ role: "user", content: "read" }] })) chunks.push(chunk); expect(chunks[0]).toMatchObject({ kind: "tool_calls", calls: [{ name: "read_file", input: { path: "a.ts" } }] }); }));
describe("purpose routing", () => it("selects a configured dedicated model without leaking provider logic into the runtime", async () => { const capabilities = { toolCalling: true, structuredOutput: false, vision: false, reasoning: false, maxContextTokens: 100 }; const fallback: ModelProvider = { id: "fallback", capabilities, generate: async () => ({ kind: "text", text: "coding" }) }; const planning: ModelProvider = { id: "planning", capabilities, generate: async () => ({ kind: "text", text: "plan" }) }; const router = new PurposeModelRouter(fallback, { planning }); await expect(router.generate({ messages: [], purpose: "planning" })).resolves.toMatchObject({ text: "plan" }); await expect(router.generate({ messages: [], purpose: "coding" })).resolves.toMatchObject({ text: "coding" }); }));
it("falls back to a tool-capable model for tool-enabled requests", async () => { const capabilities = { toolCalling: true, structuredOutput: false, vision: false, reasoning: false, maxContextTokens: 100 }; const fallback: ModelProvider = { id: "fallback", capabilities, generate: async () => ({ kind: "text", text: "fallback" }) }; const summary: ModelProvider = { id: "summary", capabilities: { ...capabilities, toolCalling: false }, generate: async () => ({ kind: "text", text: "summary" }) }; const router = new PurposeModelRouter(fallback, { summarization: summary }); await expect(router.generate({ messages: [], purpose: "summarization", tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }] })).resolves.toMatchObject({ text: "fallback" }); });
describe("additional providers", () => it("normalizes Ollama and Azure while exposing compatible provider defaults", async () => { globalThis.fetch = vi.fn(async (url: string) => new Response(url.includes("ollama") ? JSON.stringify({ message: { tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }] } }) : JSON.stringify({ choices: [{ message: { content: "azure" } }] }), { status: 200 })) as typeof fetch; const request = { messages: [{ role: "user" as const, content: "read" }] }; expect(await new OllamaProvider({ model: "local", baseUrl: "https://ollama.test" }).generate(request)).toMatchObject({ kind: "tool_calls" }); expect(await new AzureOpenAIProvider({ endpoint: "https://azure.test", apiKey: "key", deployment: "agent" }).generate(request)).toMatchObject({ text: "azure" }); expect(new DeepSeekProvider({ apiKey: "key", model: "x" })).toMatchObject({ id: "deepseek", capabilities: { reasoning: true, maxContextTokens: 1_000_000 } }); expect(new OpenRouterProvider({ apiKey: "key", model: "x" }).id).toBe("openrouter"); expect(new LmStudioProvider({ apiKey: "key", model: "x" }).id).toBe("lm-studio"); }));
describe("Bedrock provider", () => it("normalizes native Converse tool-use blocks", async () => { const provider = new BedrockProvider({ model: "anthropic.test", client: { converse: async () => ({ output: { message: { content: [{ toolUse: { toolUseId: "b", name: "read_file", input: { path: "a.ts" } } }] } }, usage: { inputTokens: 2, outputTokens: 3 } }) } }); expect(await provider.generate({ messages: [{ role: "user", content: "read" }] })).toMatchObject({ kind: "tool_calls", calls: [{ name: "read_file", input: { path: "a.ts" } }] }); }));
describe("OpenAI-compatible coding loop", () => it("drives an agent tool call against the provider contract without external credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-loop-")); await writeFile(join(root, "note.txt"), "hello\n");
  const replies = [
    { choices: [{ message: { tool_calls: [{ id: "read-1", function: { name: "read_file", arguments: '{"path":"note.txt"}' } }] } }] },
    { choices: [{ message: { content: "Read note.txt successfully." } }] }
  ];
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => { expect(init?.headers).toMatchObject({ authorization: "Bearer test-key" }); return new Response(JSON.stringify(replies.shift()), { status: 200 }); }) as typeof fetch;
  const provider = new OpenAICompatibleProvider({ baseUrl: "https://model.test/v1", apiKey: "test-key", model: "coding-model" });
  Object.defineProperty(provider, "stream", { value: undefined });
  const tools = new ToolRegistry(); registerBuiltinTools(tools); const events = new InMemoryEventSink();
  const runtime = new AgentRuntime(provider, tools, new ProgressiveContextEngine(new LocalRepositoryKnowledgeProvider({ root })), events, { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: new RulePolicyEngine() });
  const result = await runtime.run({ id: "provider-loop", prompt: "Read note.txt", workspace: root });
  expect(result.summary).toBe("Read note.txt successfully.");
  expect(events.events.map(event => event.type)).toContain("tool.executed");
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
}));

it("uses streaming provider responses for the same tool loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-stream-")); await writeFile(join(root, "note.txt"), "hello\n");
  const encoder = new TextEncoder(); let requestNumber = 0;
  globalThis.fetch = vi.fn(async () => {
    requestNumber += 1;
    const data = requestNumber === 1
      ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"read-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"note.txt\\"}"}}]}}]}\n\ndata: [DONE]\n\n'
      : 'data: {"choices":[{"delta":{"content":"Read through streaming."}}]}\n\ndata: [DONE]\n\n';
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(data)); controller.close(); } }), { status: 200 });
  }) as typeof fetch;
  const tools = new ToolRegistry(); registerBuiltinTools(tools); const events = new InMemoryEventSink();
  const runtime = new AgentRuntime(new OpenAICompatibleProvider({ baseUrl: "https://model.test/v1", apiKey: "test-key", model: "coding-model" }), tools, new ProgressiveContextEngine(new LocalRepositoryKnowledgeProvider({ root })), events, { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: new RulePolicyEngine() });
  const result = await runtime.run({ id: "provider-stream", prompt: "Read note.txt", workspace: root });
  expect(result.summary).toBe("Read through streaming.");
  expect(events.events.map(event => event.type)).toContain("tool.executed");
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});
