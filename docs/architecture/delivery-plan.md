# Usable-product delivery plan

This plan is ordered by a working vertical slice, not by the number of modules created. Each milestone must keep `pnpm build` and `pnpm test` green.

| Milestone | Outcome / acceptance criteria | Status |
| --- | --- | --- |
| M1: Usable local coding loop | A configured OpenAI-compatible model can inspect a repo, read/write files, run a user-approved test command, recover across turns, and persist JSONL events. | Implemented; live DeepSeek end-to-end read-only tool-loop validation passed |
| M2: Safe execution UX | Interactive permission prompts, command risk classification, Git status/diff, exact edits, cancellation, session resume, and secrets redaction. | Implemented; includes regression coverage for cancellation, persisted server resume, workspace confinement, and secrets redaction; needs broader adversarial coverage |
| M3: Repository intelligence | Fast indexed map/search, AST symbols/imports, test relationships, and progressive context with file excerpts. | Implemented with durable mtime/size incremental symbol cache and bounded large-repository regression coverage |
| M4: Polyglot intelligence | Production TypeScript/React, Java/Spring Boot, and Python/FastAPI detectors, commands, semantic queries, and diagnostics. | Implemented: TypeScript compiler AST, Lezer Java grammar, Python standard-library AST, framework topology, project commands, and configurable generic LSP semantic/diagnostic tools |
| M5: Provider and client surface | Native provider adapters, streaming, model routing, interactive slash commands, HTTP API, IDE/ACP transport. | Implemented: native/compatible providers, routing, streaming transport, CLI, HTTP, and JSON-RPC stdio editor transport |
| M6: Extensibility | Skill discovery, MCP stdio/HTTP adapters through policy, isolated subagents with budgets. | Implemented: skills, policy-gated MCP, and role-scoped bounded runtime delegation |
| M7: Security and operations | Docker/Podman sandbox, secret protection, adversarial tests, observability, evaluation suites, Windows validation. | Implemented: container-resident command/file operations, redaction, metrics/evals, cross-platform CI, adversarial remote-workspace confinement coverage, readiness doctor, real Docker and Podman daemon/network-isolated read-only container validation, and passing hosted Windows CI |
| M8: Advanced knowledge | LSP, Graphify provider, incremental indexing, multi-repository/remote execution. | Implemented: generic LSP client with didOpen and diagnostic support, Graphify abstraction, durable index, configured multi-repository boundaries, and an authenticated workspace-mapped remote worker validated through its loopback-only Compose deployment |

## M1 definition of done

`AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, and `AGENT_MODEL` configure an OpenAI-compatible endpoint. `agent run "task" --workspace path --permission-mode accept-edits` may read and modify files; `--permission-mode auto` also permits safe shell actions. The default remains review-only. A run ends only after the model responds without tool calls or reaches a bounded limit, and writes event history under `.agent/sessions/`.

## Design constraints

- No provider, language, or framework conditional enters `agent-core`.
- Every action goes through `ToolRegistry` and `PolicyEngine`.
- Local execution is convenience, not isolation; production security waits for M7.
- An incomplete verification is reported as incomplete, never silently treated as success.

## Remaining delivery work

The exact external validation sequence is recorded in [the release-readiness runbook](../operations/release-readiness.md).

1. Configure npm trusted publishing and publish the repeatedly verified installable release artifact. This requires the package owner to authorize an npm publication and configure npm’s trusted publisher for `.github/workflows/release.yml`.
