# Polyglot Agent Harness

An extensible TypeScript foundation for repository-aware coding agents. It deliberately separates the re-entrant agent kernel from model providers, repository intelligence, policies, sandboxes, tools, and language/framework plugins.

## Quick start

```bash
corepack enable
pnpm install
pnpm build
pnpm test
AGENT_MODEL_BASE_URL=https://your-provider.example/v1 \
AGENT_MODEL_API_KEY=... AGENT_MODEL=... \
pnpm agent -- run "add a health endpoint and tests" --workspace . --permission-mode accept-edits
```

To install the packaged CLI after building it locally, run `npm install -g ./polyglot-agent-harness-0.1.2.tgz`, then invoke `agent run "your task" --workspace /path/to/repo`. The package requires Node.js 20 or newer.

The package is configured for the public npm registry. Pushing a `v*` tag (or manually dispatching the `Publish package` workflow) runs the complete build/test/pack gate before publishing. Before triggering it, configure an npm trusted publisher for `.github/workflows/release.yml` and set `package.json`’s `repository.url` to the exact public GitHub repository URL; npm’s Node 24 release environment then publishes provenance automatically. See [npm’s trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/).

See the [release-readiness runbook](docs/operations/release-readiness.md) for the model, container, remote-worker, and npm validation sequence.

Run `pnpm agent` in a terminal for interactive mode. It supports `/help`, `/model`, `/plan`, `/permissions`, `/context`, `/agents`, `/skills`, `/mcp`, `/git`, `/diff`, `/status`, `/session`, `/compact`, and `/exit`. Headless runs accept `--sandbox local|docker|podman|remote`, `--no-color`, and `--verbose`/`--debug`/`--trace`; the latter levels add structured event detail to stderr while preserving JSON stdout.

Use `pnpm agent -- --help` to display the non-interactive command syntax.

Run `pnpm agent -- doctor --workspace /path/to/repo` before a coding run to check the selected model, declared verification commands, sandbox availability, Node version, and LSP configuration. Add `--json` for machine-readable output.

The CLI is review-only by default. `accept-edits` permits file changes but requests shell/Git actions; `auto` permits the built-in test/build allowlist only in an isolated sandbox with unchanged verification definitions. Local test/build execution always requires approval because repository programs have host access. Other commands are always treated as approval-required. In an interactive terminal, required approvals show the complete action, arguments, workspace, risk, and proposed edit content; JSON/headless runs deny them. Each run writes JSONL events to `.agent/sessions/`.

The model can use repository map, symbol, reference, dependency, and test-relationship context. TypeScript/JavaScript declarations and imports are parsed structurally with the TypeScript compiler API. Java uses the maintained Lezer Java grammar for declarations and syntax diagnostics. Python uses its standard-library AST for declarations and syntax diagnostics when an interpreter is available, with a dependable text fallback. Configure an LSP for definitions, references, hover, and richer project semantics.

Before a coding run, declared test/build/lint commands are snapshotted from the repository. The standard `run_test` and `run_build` tools discover Node package scripts plus Maven, Gradle, and Python (`pyproject.toml`/`pytest.ini`) projects; Python test runs prefer `uv run pytest` when `uv.lock` exists. After an edit, the runtime executes that snapshot through the policy gate and returns failed output to the model for repair. The snapshot includes content hashes of verification manifests, wrappers, and lockfiles. Changed or newly introduced definitions require renewed approval, including through `run_test`, `run_build`, and direct shell calls. Blocked or unavailable checks produce an `unverified` outcome, not verified success. This checks verification definitions, not the integrity or adequacy of the tests themselves.

Inspect a completed session with `pnpm agent -- session SESSION_ID --workspace /path/to/repo --json`, or continue it with `pnpm agent -- resume SESSION_ID "follow-up task" --workspace /path/to/repo`. Press `Ctrl-C` to cancel the run, including active model requests and command process groups. Cancellation propagates to verification and delegated runs. Local process-group termination covers ordinary descendants; use container isolation for untrusted programs that could deliberately detach themselves.

See [architecture](docs/architecture/architecture-decision-record.md) and [research notes](docs/research/agent-harnesses.md).

Copy `.agent/config.example.json` to `.agent/config.json` to configure a repository. Configurations enabling MCP, LSP, additional repositories, sandbox settings, or permission overrides require an operator-controlled trust pin before initialization. Review the configuration, run `agent config-digest --workspace /path/to/repo`, and place the printed hash in `AGENT_TRUSTED_CONFIG_SHA256` in your launch environment. The digest binds the parsed configuration to the canonical workspace path; changes require a new review and pin. Do not automatically regenerate the pin at startup or store it in repository-controlled scripts. Keep API keys in the named environment variable, not in the configuration file.

Repository skills are discovered from `.agent/skills/` and `skills/`, but must be explicitly named in `skills.enabled` before their contents are included in model context.

The optional HTTP API binds to loopback by default. Set `AGENT_SERVER_API_KEY` to require a bearer token and `AGENT_SERVER_RATE_LIMIT` to cap requests per minute per client.

To run the real-provider smoke fixture in a controlled release environment, set `AGENT_REAL_PROVIDER_E2E=1` together with `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, and `AGENT_MODEL`, then run `pnpm test -- tests/integration/real-provider-e2e.test.ts`. It uses an isolated temporary repository and a read-only policy; it is skipped by default to avoid credential use and model charges during ordinary development.

Use `POST /runs` for a JSON result or `POST /runs/stream` for Server-Sent Events. The stream forwards structured agent events such as planning, tool requests, approvals, execution, verification, completion, and failure as they occur.

Use `POST /runs/background` to start a managed asynchronous run; it returns a `sessionId`, and `GET /runs/{sessionId}` returns its current state, result, and emitted events. `DELETE /runs/{sessionId}` requests cancellation and reports `cancelling` until execution settles. The final status preserves `completed`, `unverified`, `failed`, or `cancelled`. Active session collisions and overlapping runs on the same workspace are rejected; completed history can be evicted, active runs cannot. The HTTP server defaults to four concurrent runs across different workspaces. CLI, server, and ACP entry points also acquire cross-process ownership of every attached workspace. An unconfirmed termination fails the run and retains its workspace lock until an operator checks execution. If a process is forcibly killed, inspect the PID in the reported temporary lock directory before manually removing a stale lock. All server and ACP run requests accept an optional `sessionId` and `resume: true` to continue a persisted session.

For HTTP MCP servers, set `mcp[].bearerTokenEnv` in `.agent/config.json`; the token is read from that environment variable and never stored in configuration or session events.

`model.provider` accepts `openai-compatible`, `anthropic`, `gemini`, `azure-openai`, `deepseek`, `ollama`, `openrouter`, and `lm-studio`. The `deepseek` preset defaults to `https://api.deepseek.com`; set `apiKeyEnv` to `DEEPSEEK_API_KEY` and choose `deepseek-v4-flash` or `deepseek-v4-pro`. Add `model.fallbacks` to try compatible alternatives in order when a provider fails. The model gateway also provides a native `BedrockProvider` for applications that supply an authenticated AWS Converse client.

Set `model.roles` in `.agent/config.json` to choose dedicated providers for `planning`, `coding`, `exploration`, `summarization`, `review`, or `commit_message`; unspecified roles use the primary/fallback router.

Add `repositories` in `.agent/config.json` to attach explicitly named sibling repositories. Tools and repository context use `name:path` syntax for those roots; unconfigured aliases and traversal remain blocked.

Set `sandbox.kind` to `remote` with a `remote.endpoint`, `remote.workspaceId`, and optional `remote.bearerTokenEnv` to use an authenticated remote worker. It uses scoped `POST /v1/workspaces/{workspaceId}/execute|read|write` calls; command and file paths are converted to workspace-relative paths. Run `AGENT_REMOTE_WORKSPACES='{"my-repository":"/srv/repos/my-repository"}' AGENT_REMOTE_WORKER_TOKEN=... pnpm remote-worker` on the trusted worker host. The worker authenticates every request and executes commands in a Docker or Podman container mounting only the mapped workspace. Set `AGENT_REMOTE_RUNTIME` and `AGENT_REMOTE_IMAGE` on the worker host to select its runtime and tool image; unconfined local execution is rejected. A deployable Docker Compose template is available in `deploy/remote-worker/`; it exposes only host loopback and requires an explicit token.

Set `lsp.command` and `lsp.args` to launch an optional stdio language server for a run. When configured, the agent can use `lsp_definition`, `lsp_references`, `lsp_hover`, and `lsp_symbols`; the repository and plugin fallbacks continue to work when no LSP is installed.

For editor integrations, `pnpm acp` starts a newline-delimited JSON-RPC stdio transport. It implements `initialize` and `agent/run`, emits `agent/event` notifications while a run is active, and uses the same configured workspace, model, policy, and sandbox as the HTTP server.


Run `AGENT_CONTAINER_E2E=1 pnpm test -- tests/integration/container-isolation.test.ts` to verify real container confinement, executable permissions, and cancellation. This requires Docker and may pull `node:20-bookworm-slim`; set `AGENT_CONTAINER_IMAGE` to use another prepared Node image. Ordinary tests include loopback HTTP lifecycle regressions and therefore need permission to bind temporary local ports.
