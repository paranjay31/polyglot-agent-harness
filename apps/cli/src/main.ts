#!/usr/bin/env node
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { AgentRuntime } from "../../../packages/agent-core/src/index.js";
import { assertTrustedRepositoryConfig, repositoryConfigDigest, loadRepositoryConfig, type AgentConfig } from "../../../packages/config/src/index.js";
import { inspectReadiness } from "../../../packages/diagnostics/src/index.js";
import { ProgressiveContextEngine } from "../../../packages/context-engine/src/index.js";
import { AnthropicProvider, AzureOpenAIProvider, DeepSeekProvider, GeminiProvider, LmStudioProvider, ModelRouter, OllamaProvider, OpenAICompatibleProvider, OpenRouterProvider, PurposeModelRouter, ScriptedModelProvider, type ModelProvider } from "../../../packages/model-gateway/src/index.js";
import { HttpMcpClient, McpToolAdapter, StdioMcpClient, type McpClient } from "../../../packages/mcp/src/index.js";
import { formatApprovalRequest, PatternPolicyEngine, type Permission, type PolicyDecision, type PolicyRequest } from "../../../packages/policy/src/index.js";
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
import { ReactPlugin } from "../../../plugins/react/src/index.js";
import { SpringBootPlugin } from "../../../plugins/springboot/src/index.js";
import { TypeScriptPlugin } from "../../../plugins/typescript/src/index.js";
import { JavaPlugin } from "../../../plugins/java/src/index.js";
import { PythonPlugin } from "../../../plugins/python/src/index.js";

type ModelTarget = Omit<AgentConfig["model"], "fallbacks" | "roles">;
const args = process.argv.slice(2).filter(arg => arg !== "--");
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const json = args.includes("--json");
const logLevel = args.includes("--trace") ? "trace" : args.includes("--debug") ? "debug" : args.includes("--verbose") ? "verbose" : "normal";
const workspace = resolve(value("--workspace") ?? process.cwd());
const maxTurns = Number(value("--max-turns") ?? 12);
let permissionModeArgument = value("--permission-mode");
let modelOverride = value("--model");
let sandboxOverride = value("--sandbox");
const resumeSessionId = args[0] === "resume" ? args[1] : undefined;
const optionNames = new Set(["--workspace", "--max-turns", "--permission-mode", "--model", "--sandbox", "--no-color", "--verbose", "--debug", "--trace"]);
let prompt = args.filter((arg, index) => arg !== "run" && arg !== "resume" && index !== (resumeSessionId ? 1 : -1) && arg !== "--json" && !optionNames.has(arg) && !optionNames.has(args[index - 1] ?? "")).join(" ") || "inspect this repository";

class FanoutEvents implements EventSink { constructor(private readonly sinks: EventSink[]) {} append(event: AgentEvent) { return Promise.all(this.sinks.map(sink => sink.append(event))).then(() => undefined); } }
class TerminalEventSink implements EventSink { async append(event: AgentEvent) { if (json) return; const detail = logLevel === "trace" ? ` ${JSON.stringify(event)}` : logLevel === "debug" ? ` ${JSON.stringify(event.data)}` : logLevel === "verbose" ? ` ${JSON.stringify(event.data).slice(0, 1_000)}` : ""; process.stderr.write(`[agent turn ${event.turn}] ${event.type}${detail}\n`); } }
function configuredTarget(target: ModelTarget, primary: boolean): ModelProvider | undefined {
  const provider = primary ? process.env.AGENT_MODEL_PROVIDER ?? target.provider : target.provider;
  const name = primary ? modelOverride ?? process.env.AGENT_MODEL ?? target.name : target.name;
  const baseUrl = primary ? process.env.AGENT_MODEL_BASE_URL ?? target.baseUrl : target.baseUrl;
  const apiKey = primary ? process.env.AGENT_MODEL_API_KEY ?? (target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined) : target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  if (!name) return undefined;
  if (provider === "ollama") return new OllamaProvider({ model: name, baseUrl });
  if (provider === "lm-studio") return new LmStudioProvider({ model: name, apiKey: apiKey ?? "not-needed", baseUrl });
  if (provider === "anthropic" && apiKey) return new AnthropicProvider({ apiKey, model: name, baseUrl });
  if (provider === "gemini" && apiKey) return new GeminiProvider({ apiKey, model: name, baseUrl });
  if (provider === "azure-openai" && apiKey && baseUrl) return new AzureOpenAIProvider({ endpoint: baseUrl, apiKey, deployment: name, apiVersion: target.apiVersion });
  if (provider === "deepseek" && apiKey) return new DeepSeekProvider({ apiKey, model: name, baseUrl });
  if (provider === "openrouter" && apiKey) return new OpenRouterProvider({ apiKey, model: name, baseUrl });
  return apiKey && baseUrl ? new OpenAICompatibleProvider({ apiKey, model: name, baseUrl }) : undefined;
}
function configuredModel(config: AgentConfig) { const providers = [configuredTarget(config.model, true), ...config.model.fallbacks.map(target => configuredTarget(target, false))].filter((model): model is ModelProvider => Boolean(model)); const fallback = providers.length > 1 ? new ModelRouter(providers) : providers[0]; const roles = Object.fromEntries(Object.entries(config.model.roles).flatMap(([purpose, target]) => { const model = target && configuredTarget(target, false); return model ? [[purpose, model]] : []; })) as Partial<Record<"planning" | "coding" | "exploration" | "summarization" | "review" | "commit_message", ModelProvider>>; return fallback ? Object.keys(roles).length ? new PurposeModelRouter(fallback, roles) : fallback : (Object.values(roles) as ModelProvider[])[0]; }
async function registerConfiguredMcp(config: AgentConfig, registry: ToolRegistry): Promise<McpClient[]> { const clients: McpClient[] = []; for (const server of config.mcp) { const headers = { ...server.headers, ...(server.bearerTokenEnv && process.env[server.bearerTokenEnv] ? { authorization: `Bearer ${process.env[server.bearerTokenEnv]}` } : {}) }; const client = server.transport === "stdio" ? await StdioMcpClient.connect(server.id, server.command ?? (() => { throw new Error(`MCP ${server.id} requires command`); })(), server.args ?? []) : new HttpMcpClient(server.id, server.endpoint ?? (() => { throw new Error(`MCP ${server.id} requires endpoint`); })(), headers); clients.push(client); try { await new McpToolAdapter(client).register(registry); } catch (error) { await Promise.allSettled(clients.map(active => active.close?.())); throw error; } } return clients; }
function policyFor(mode: string, rules: AgentConfig["permissions"]["rules"] = []) { const ask: PolicyDecision = "ask", allow: PolicyDecision = "allow"; const defaults: Partial<Record<Permission, PolicyDecision>> = mode === "auto" ? { write: allow, edit: allow, shell: allow, git: allow, mcp: ask } : mode === "accept-edits" ? { write: allow, edit: allow, shell: ask, git: ask, mcp: ask } : { write: ask, edit: ask, shell: ask, git: ask, mcp: ask }; if (!["review", "accept-edits", "auto"].includes(mode)) throw new Error("--permission-mode must be review, accept-edits, or auto"); return new PatternPolicyEngine(defaults, rules); }
function interactiveApprover(request: PolicyRequest & { tool: string; input: unknown }) { return async () => { if (json || !process.stdin.isTTY || !process.stdout.isTTY) return false; const terminal = createInterface({ input: process.stdin, output: process.stdout }); try { return /^y(es)?$/i.test((await terminal.question(formatApprovalRequest(request))).trim()); } finally { terminal.close(); } }; }
async function main() {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write("Usage: agent [run] TASK --workspace PATH [--permission-mode review|accept-edits|auto] [--sandbox local|docker|podman|remote] [--json]\n       agent doctor --workspace PATH [--json]\n       agent config-digest --workspace PATH\n       agent session SESSION_ID --workspace PATH [--json]\n       agent resume SESSION_ID TASK --workspace PATH\n"); return; }
  const store = new JsonlSessionStore(join(workspace, ".agent", "sessions"));
  if (args[0] === "session") { const events = await store.replay(args[1] ?? ""); if (!events.length) throw new Error("Session was not found"); process.stdout.write(json ? JSON.stringify(events, null, 2) + "\n" : events.map(event => `${event.timestamp} ${event.type} ${JSON.stringify(event.data)}`).join("\n") + "\n"); return; }
  const prior = resumeSessionId ? await store.replay(resumeSessionId) : []; if (resumeSessionId && !prior.length) throw new Error("Session was not found");
  const originalTask = (prior.find(event => event.type === "agent.started")?.data as { task?: string } | undefined)?.task;
  const history = prior.slice(-30).map(event => `${event.type}: ${JSON.stringify(event.data)}`).join("\n").slice(-12_000);
  const task = resumeSessionId ? `${originalTask ?? prompt}\n\nResume request: ${prompt}\nPrior execution history:\n${history}` : prompt;
  const config = await loadRepositoryConfig(workspace);
  if (args[0] === "config-digest") { process.stdout.write(await repositoryConfigDigest(workspace, config) + "\n"); return; }
  await assertTrustedRepositoryConfig(workspace, config);
  if (args[0] === "doctor") { const report = await inspectReadiness(workspace, config); process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : report.checks.map(check => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n") + "\n"); if (!report.ready) process.exitCode = 1; return; }
  const release = await acquireWorkspaceLease([workspace, ...Object.values(config.repositories).map(path => resolve(workspace, path))]);
  let quarantine = false; const clients: McpClient[] = []; let languageServer: StdioLanguageServer | undefined;
  const controller = new AbortController(); const cancel = () => controller.abort(); process.once("SIGINT", cancel);
  try {
  const roots = { main: workspace, ...Object.fromEntries(Object.entries(config.repositories).map(([id, path]) => [id, resolve(workspace, path)])) }; const providers = Object.fromEntries(Object.entries(roots).map(([id, root]) => [id, new LanguageEnrichedRepositoryKnowledgeProvider(new LocalRepositoryKnowledgeProvider({ root }), { root }, [new TypeScriptPlugin(), new JavaPlugin(), new PythonPlugin()]) ])); const semanticRepository = new MultiRepositoryKnowledgeProvider(providers, "main"); const repository = new FrameworkEnrichedRepositoryKnowledgeProvider(semanticRepository, { root: workspace }, [new ReactPlugin(), new SpringBootPlugin(), new FastApiPlugin()]); const profile = await repository.detectRepository();
  const registry = new ToolRegistry(); registerBuiltinTools(registry); clients.push(...await registerConfiguredMcp(config, registry)); const memory = new InMemoryEventSink(), metrics = new MetricsEventSink(); const events = new RedactingEventSink(new FanoutEvents([memory, store, metrics, new TerminalEventSink()]));
  const selected = configuredModel(config) ?? new ScriptedModelProvider([{ kind: "text", text: `No model is configured. Repository detected: ${profile.languages.join(", ") || "unknown"}. Set model configuration or AGENT_MODEL_* environment variables.` }]);

  const sandboxKind = sandboxOverride ?? config.sandbox.kind;
  if (!["local", "docker", "podman", "remote"].includes(sandboxKind)) throw new Error("--sandbox must be local, docker, podman, or remote");
  if (sandboxKind === "remote" && !config.sandbox.remote) throw new Error("Remote sandbox configuration is required for --sandbox remote");
  const sandbox = sandboxKind === "docker" ? new DockerSandbox({ workspace, image: config.sandbox.image ?? "node:20" }) : sandboxKind === "podman" ? new PodmanSandbox({ workspace, image: config.sandbox.image ?? "node:20" }) : sandboxKind === "remote" ? new RemoteSandbox(config.sandbox.remote!.workspaceId, new HttpRemoteExecutor({ endpoint: config.sandbox.remote!.endpoint, bearerToken: config.sandbox.remote!.bearerTokenEnv ? process.env[config.sandbox.remote!.bearerTokenEnv] : undefined }), workspace) : new LocalSandbox(); languageServer = config.lsp ? new StdioLanguageServer(config.lsp.command, config.lsp.args, `file://${workspace}`) : undefined;
  const toolContext = { workspace: new MultiWorkspaceBoundary(roots, "main"), sandbox, policy: policyFor(permissionModeArgument ?? config.permissions.mode, config.permissions.rules), knowledge: repository, languageServer, approve: async (request: any) => interactiveApprover(request)() };
  const runtime = new AgentRuntime(selected, registry, new ProgressiveContextEngine(repository), events, toolContext, new ToolVerificationRunner(await new RepositoryVerificationPlanner(workspace).commands(), registry, toolContext), new SkillRegistry(workspace, config.skills.enabled));
  const result = await runtime.run({ id: "cli", prompt: task, workspace }, { maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 12, signal: controller.signal, sessionId: resumeSessionId });
  quarantine = result.executionUnconfirmed ?? false;
  if (result.state === "failed" || result.state === "unverified" || result.state === "cancelled") process.exitCode = 1;
  const output = { result, profile, permissionMode: permissionModeArgument ?? config.permissions.mode, resumed: Boolean(resumeSessionId), metrics: metrics.get(result.sessionId), events: memory.events }; process.stdout.write(json ? JSON.stringify(output, null, 2) + "\n" : `${result.summary ?? result.error}\n\nSession: ${result.sessionId}\nMetrics: ${JSON.stringify(output.metrics)}\n`);
  } finally { process.removeListener("SIGINT", cancel); await Promise.allSettled([...clients.map(client => client.close?.()), languageServer?.shutdown()]); if (!quarantine) await release(); }
}
const help = "Commands: /help, /model [name], /plan [task], /permissions [review|accept-edits|auto], /context [task], /agents, /skills, /mcp, /git, /diff, /status, /session ID, /compact, /exit";
async function launch() {
  if (args.length || json || !process.stdin.isTTY) return main();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const report = (value: string) => process.stdout.write(`${value}\n`);
  try {
    for (;;) {
      const line = (await terminal.question("agent> ")).trim();
      const [command, ...rest] = line.split(/\s+/), argument = rest.join(" ").trim();
      if (command === "/exit") return;
      if (command === "/help") { report(help); continue; }
      if (command === "/model") { if (argument) modelOverride = argument; report(`Model override: ${modelOverride ?? "configured model"}`); continue; }
      if (command === "/permissions") { if (argument) permissionModeArgument = argument; report(`Permission mode: ${permissionModeArgument ?? "repository default"}`); continue; }
      if (command === "/status") { report(`Workspace: ${workspace}\nModel: ${modelOverride ?? "configured model"}\nPermissions: ${permissionModeArgument ?? "repository default"}\nSandbox: ${sandboxOverride ?? "repository default"}`); continue; }
      if (command === "/agents") { report("Subagents are available to a run through the policy-gated delegate tool."); continue; }
      if (command === "/compact") { report("Context compaction is automatic when the configured context budget is reached."); continue; }
      if (command === "/skills" || command === "/mcp") { const config = await loadRepositoryConfig(workspace); report(command === "/skills" ? `Enabled skills: ${config.skills.enabled.join(", ") || "none"}` : `Configured MCP servers: ${config.mcp.map(server => server.id).join(", ") || "none"}`); continue; }
      if (command === "/git" || command === "/diff") { const result = await new LocalSandbox().execute({ argv: command === "/git" ? ["git", "status", "--short"] : ["git", "diff"], cwd: workspace, risk: "safe" }); report(result.stdout || result.stderr || "No changes."); continue; }
      if (command === "/session") { if (!argument) { report("Usage: /session SESSION_ID"); continue; } const events = await new JsonlSessionStore(join(workspace, ".agent", "sessions")).replay(argument); report(events.length ? events.map(event => `${event.timestamp} ${event.type} ${JSON.stringify(event.data)}`).join("\n") : "Session was not found."); continue; }
      if (command === "/plan" || command === "/context") { prompt = `${command === "/plan" ? "Inspect the repository and produce a concise implementation plan only" : "Inspect the repository and report the most relevant context"}${argument ? `: ${argument}` : "."}`; await main(); continue; }
      if (line && !line.startsWith("/")) { prompt = line; await main(); continue; }
      report(`Unknown command. ${help}`);
    }
  } finally { terminal.close(); }
}
launch().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
