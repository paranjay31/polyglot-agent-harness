#!/usr/bin/env node
import { join, resolve } from "node:path";
import { createAgentServer, type AgentRunHandler, type AgentRunRequest } from "./index.js";
import { AgentRuntime } from "../../../packages/agent-core/src/index.js";
import { assertTrustedRepositoryConfig, repositoryConfigDigest, loadRepositoryConfig, type AgentConfig } from "../../../packages/config/src/index.js";
import { ProgressiveContextEngine } from "../../../packages/context-engine/src/index.js";
import { AnthropicProvider, AzureOpenAIProvider, DeepSeekProvider, GeminiProvider, LmStudioProvider, ModelRouter, OllamaProvider, OpenAICompatibleProvider, OpenRouterProvider, PurposeModelRouter, ScriptedModelProvider, type ModelProvider } from "../../../packages/model-gateway/src/index.js";
import { HttpMcpClient, McpToolAdapter, StdioMcpClient, type McpClient } from "../../../packages/mcp/src/index.js";
import { PatternPolicyEngine, type Permission, type PolicyDecision } from "../../../packages/policy/src/index.js";
import { InMemoryEventSink, RedactingEventSink, type AgentEvent, type EventSink } from "../../../packages/protocol/src/index.js";
import { MetricsEventSink } from "../../../packages/observability/src/index.js";
import { LocalRepositoryKnowledgeProvider } from "../../../packages/repository/src/index.js";
import { FrameworkEnrichedRepositoryKnowledgeProvider, LanguageEnrichedRepositoryKnowledgeProvider, MultiRepositoryKnowledgeProvider } from "../../../packages/repository-intelligence/src/index.js";
import { DockerSandbox, HttpRemoteExecutor, LocalSandbox, PodmanSandbox, RemoteSandbox } from "../../../packages/sandbox/src/index.js";
import { acquireWorkspaceLease, JsonlSessionStore } from "../../../packages/session/src/index.js";
import { StdioLanguageServer } from "../../../packages/language-services/src/index.js";
import { SkillRegistry } from "../../../packages/skills/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../../packages/tool-runtime/src/index.js";
import { RepositoryVerificationPlanner, ToolVerificationRunner } from "../../../packages/verification/src/index.js";
import { MultiWorkspaceBoundary } from "../../../packages/workspace/src/index.js";
import { FastApiPlugin } from "../../../plugins/fastapi/src/index.js";
import { JavaPlugin } from "../../../plugins/java/src/index.js";
import { PythonPlugin } from "../../../plugins/python/src/index.js";
import { ReactPlugin } from "../../../plugins/react/src/index.js";
import { SpringBootPlugin } from "../../../plugins/springboot/src/index.js";
import { TypeScriptPlugin } from "../../../plugins/typescript/src/index.js";

type ModelTarget = Omit<AgentConfig["model"], "fallbacks" | "roles">;
function modelTarget(target: ModelTarget, primary: boolean): ModelProvider | undefined { const provider = primary ? process.env.AGENT_MODEL_PROVIDER ?? target.provider : target.provider, name = primary ? process.env.AGENT_MODEL ?? target.name : target.name, baseUrl = primary ? process.env.AGENT_MODEL_BASE_URL ?? target.baseUrl : target.baseUrl, apiKey = primary ? process.env.AGENT_MODEL_API_KEY ?? (target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined) : target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined; if (!name) return undefined; if (provider === "ollama") return new OllamaProvider({ model: name, baseUrl }); if (provider === "lm-studio") return new LmStudioProvider({ model: name, apiKey: apiKey ?? "not-needed", baseUrl }); if (provider === "anthropic" && apiKey) return new AnthropicProvider({ apiKey, model: name, baseUrl }); if (provider === "gemini" && apiKey) return new GeminiProvider({ apiKey, model: name, baseUrl }); if (provider === "azure-openai" && apiKey && baseUrl) return new AzureOpenAIProvider({ endpoint: baseUrl, apiKey, deployment: name, apiVersion: target.apiVersion }); if (provider === "deepseek" && apiKey) return new DeepSeekProvider({ apiKey, model: name, baseUrl }); if (provider === "openrouter" && apiKey) return new OpenRouterProvider({ apiKey, model: name, baseUrl }); return apiKey && baseUrl ? new OpenAICompatibleProvider({ apiKey, model: name, baseUrl }) : undefined; }
function configuredModel(config: AgentConfig) { const providers = [modelTarget(config.model, true), ...config.model.fallbacks.map(target => modelTarget(target, false))].filter((model): model is ModelProvider => Boolean(model)); const fallback = providers.length > 1 ? new ModelRouter(providers) : providers[0]; const roles = Object.fromEntries(Object.entries(config.model.roles).flatMap(([purpose, target]) => { const model = target && modelTarget(target, false); return model ? [[purpose, model]] : []; })) as Partial<Record<"planning" | "coding" | "exploration" | "summarization" | "review" | "commit_message", ModelProvider>>; return fallback ? Object.keys(roles).length ? new PurposeModelRouter(fallback, roles) : fallback : (Object.values(roles) as ModelProvider[])[0]; }
class FanoutSink implements EventSink { constructor(private readonly sinks: EventSink[], private readonly emit?: (event: AgentEvent) => Promise<void>) {} async append(event: AgentEvent) { await Promise.all(this.sinks.map(sink => sink.append(event))); await this.emit?.(event); } }
function policyFor(mode: "review" | "accept-edits" | "auto", rules: AgentConfig["permissions"]["rules"]) { const ask: PolicyDecision = "ask", allow: PolicyDecision = "allow"; return new PatternPolicyEngine(mode === "auto" ? { write: allow, edit: allow, shell: allow, git: allow, mcp: ask } : mode === "accept-edits" ? { write: allow, edit: allow, shell: ask, git: ask, mcp: ask } : { write: ask, edit: ask, shell: ask, git: ask, mcp: ask } satisfies Partial<Record<Permission, PolicyDecision>>, rules); }
async function registerConfiguredMcp(config: AgentConfig, registry: ToolRegistry): Promise<McpClient[]> { const clients: McpClient[] = []; for (const server of config.mcp) { const headers = { ...server.headers, ...(server.bearerTokenEnv && process.env[server.bearerTokenEnv] ? { authorization: `Bearer ${process.env[server.bearerTokenEnv]}` } : {}) }; const client = server.transport === "stdio" ? await StdioMcpClient.connect(server.id, server.command ?? (() => { throw new Error(`MCP ${server.id} requires command`); })(), server.args ?? []) : new HttpMcpClient(server.id, server.endpoint ?? (() => { throw new Error(`MCP ${server.id} requires endpoint`); })(), headers); clients.push(client); try { await new McpToolAdapter(client).register(registry); } catch (error) { await Promise.allSettled(clients.map(active => active.close?.())); throw error; } } return clients; }
export async function createConfiguredRunHandler(workspace: string): Promise<AgentRunHandler> {
  const root = resolve(workspace), config = await loadRepositoryConfig(root);
  await assertTrustedRepositoryConfig(root, config);
  const execute = async (request: AgentRunRequest, emit?: (event: AgentEvent) => Promise<void>) => {
    if (resolve(request.workspace) !== root) throw new Error("Server only permits its configured workspace");
    request.signal?.throwIfAborted();
    const release = await acquireWorkspaceLease([root, ...Object.values(config.repositories).map(path => resolve(root, path))]);
    let quarantine = false; const clients: McpClient[] = []; let languageServer: StdioLanguageServer | undefined;
    try {
    const roots = { main: root, ...Object.fromEntries(Object.entries(config.repositories).map(([id, path]) => [id, resolve(root, path)])) };
    const providers = Object.fromEntries(Object.entries(roots).map(([id, repositoryRoot]) => [id, new LanguageEnrichedRepositoryKnowledgeProvider(new LocalRepositoryKnowledgeProvider({ root: repositoryRoot }), { root: repositoryRoot }, [new TypeScriptPlugin(), new JavaPlugin(), new PythonPlugin()]) ]));
    const repository = new FrameworkEnrichedRepositoryKnowledgeProvider(new MultiRepositoryKnowledgeProvider(providers, "main"), { root }, [new ReactPlugin(), new SpringBootPlugin(), new FastApiPlugin()]);
    const tools = new ToolRegistry(); registerBuiltinTools(tools); clients.push(...await registerConfiguredMcp(config, tools)); const memory = new InMemoryEventSink(), metrics = new MetricsEventSink(); const store = new JsonlSessionStore(join(root, ".agent", "sessions"));
    const sandbox = config.sandbox.kind === "docker" ? new DockerSandbox({ workspace: root, image: config.sandbox.image ?? "node:20" }) : config.sandbox.kind === "podman" ? new PodmanSandbox({ workspace: root, image: config.sandbox.image ?? "node:20" }) : config.sandbox.kind === "remote" ? new RemoteSandbox(config.sandbox.remote!.workspaceId, new HttpRemoteExecutor({ endpoint: config.sandbox.remote!.endpoint, bearerToken: config.sandbox.remote!.bearerTokenEnv ? process.env[config.sandbox.remote!.bearerTokenEnv] : undefined }), root) : new LocalSandbox();
    languageServer = config.lsp ? new StdioLanguageServer(config.lsp.command, config.lsp.args, `file://${root}`) : undefined;
    const toolContext = { workspace: new MultiWorkspaceBoundary(roots, "main"), sandbox, policy: policyFor(request.permissionMode ?? config.permissions.mode, config.permissions.rules), knowledge: repository, languageServer, approve: async () => false };
    const runtime = new AgentRuntime(configuredModel(config) ?? new ScriptedModelProvider([{ kind: "text", text: "No model is configured for this server." }]), tools, new ProgressiveContextEngine(repository), new RedactingEventSink(new FanoutSink([memory, store, metrics], emit)), toolContext, new ToolVerificationRunner(() => new RepositoryVerificationPlanner(root).commands(), tools, toolContext), new SkillRegistry(root, config.skills.enabled));
    const prior = request.resume && request.sessionId ? await store.replay(request.sessionId) : []; if (request.resume && !prior.length) throw new Error("Session was not found"); const originalTask = (prior.find(event => event.type === "agent.started")?.data as { task?: string } | undefined)?.task; const history = prior.slice(-30).map(event => `${event.type}: ${JSON.stringify(event.data)}`).join("\n").slice(-12_000); const task = request.resume ? `${originalTask ?? request.task}\n\nResume request: ${request.task}\nPrior execution history:\n${history}` : request.task;
    const result = await runtime.run({ id: "server", prompt: task, workspace: root }, { maxTurns: request.maxTurns ?? 12, sessionId: request.sessionId, signal: request.signal }); quarantine = result.executionUnconfirmed ?? false; return { result, metrics: metrics.get(result.sessionId), events: memory.events };
    } finally { await Promise.allSettled([...clients.map(client => client.close?.()), languageServer?.shutdown()]); if (!quarantine) await release(); }
  };
  return { run: request => execute(request), runStreaming: (request, emit) => execute(request, emit) };
}
async function main() { const workspace = resolve(process.env.AGENT_SERVER_WORKSPACE ?? process.cwd()), port = Number(process.env.PORT ?? 8787), limit = process.env.AGENT_SERVER_RATE_LIMIT ? Number(process.env.AGENT_SERVER_RATE_LIMIT) : undefined; createAgentServer(await createConfiguredRunHandler(workspace), { apiKey: process.env.AGENT_SERVER_API_KEY, maxRequestsPerMinute: Number.isFinite(limit) ? limit : undefined }).listen(port, "127.0.0.1", () => process.stdout.write(`Agent server listening on http://127.0.0.1:${port}\n`)); }
if (process.argv[1]?.endsWith("apps/server/src/main.ts") || process.argv[1]?.endsWith("apps/server/src/main.js")) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
