import type { AgentConfig } from "../../config/src/index.js";
import { LocalSandbox } from "../../sandbox/src/index.js";
import { RepositoryVerificationPlanner } from "../../verification/src/index.js";

export interface ReadinessCheck { name: string; status: "pass" | "warn" | "fail"; detail: string }
export interface ReadinessReport { workspace: string; ready: boolean; checks: ReadinessCheck[] }

/** Performs local, side-effect-free readiness checks before a coding run. */
export async function inspectReadiness(workspace: string, config: AgentConfig, environment: NodeJS.ProcessEnv = process.env): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const node = Number(process.versions.node.split(".")[0]); checks.push(node >= 20 ? { name: "node", status: "pass", detail: `Node ${process.versions.node}` } : { name: "node", status: "fail", detail: `Node ${process.versions.node}; Node 20 or later is required` });
  const provider = environment.AGENT_MODEL_PROVIDER ?? config.model.provider, name = environment.AGENT_MODEL ?? config.model.name, baseUrl = environment.AGENT_MODEL_BASE_URL ?? config.model.baseUrl, key = environment.AGENT_MODEL_API_KEY ?? (config.model.apiKeyEnv ? environment[config.model.apiKeyEnv] : undefined);
  const localProvider = provider === "ollama" || provider === "lm-studio";
  checks.push(!name ? { name: "model", status: "fail", detail: "No model configured; set AGENT_MODEL_BASE_URL, AGENT_MODEL_API_KEY, and AGENT_MODEL" } : !localProvider && (!baseUrl || !key) ? { name: "model", status: "fail", detail: `Model ${name} is missing ${!baseUrl ? "a base URL" : "an API key"}` } : { name: "model", status: "pass", detail: `${provider}: ${name}` });
  const commands = await new RepositoryVerificationPlanner(workspace).commands(); checks.push(commands.length ? { name: "verification", status: "pass", detail: commands.map(command => command.argv.join(" ")).join("; ") } : { name: "verification", status: "warn", detail: "No declared test, build, or lint command was found" });
  if (config.sandbox.kind === "local") checks.push({ name: "sandbox", status: "pass", detail: "local" });
  else if (config.sandbox.kind === "remote") { const token = config.sandbox.remote?.bearerTokenEnv; checks.push(token && !environment[token] ? { name: "sandbox", status: "warn", detail: `remote worker token ${token} is not set` } : { name: "sandbox", status: "pass", detail: `remote workspace ${config.sandbox.remote?.workspaceId}` }); }
  else { const result = await new LocalSandbox().execute({ argv: [config.sandbox.kind, "version", "--format", "{{.Server.Version}}"], cwd: workspace, timeoutMs: 5_000 }); checks.push(result.exitCode === 0 ? { name: "sandbox", status: "pass", detail: `${config.sandbox.kind} daemon ${result.stdout.trim()}` } : { name: "sandbox", status: "fail", detail: `${config.sandbox.kind} is unavailable: ${(result.stderr || result.stdout).trim().slice(0, 300)}` }); }
  checks.push(config.lsp ? { name: "lsp", status: "pass", detail: `${config.lsp.command} ${config.lsp.args.join(" ")}`.trim() } : { name: "lsp", status: "warn", detail: "No language server configured; parser and repository fallbacks remain available" });
  return { workspace, ready: !checks.some(check => check.status === "fail"), checks };
}
