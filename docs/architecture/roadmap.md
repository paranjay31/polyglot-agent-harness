# Delivery roadmap

Implemented in this foundation:

- Phase 1 kernel: bounded evented runtime, normalized model interface, registry-based tools, policy gate, local sandbox, workspace boundary, sessions, CLI skeleton.
- Phase 2 baseline: local repository detection, map, text search, lightweight symbol/reference/dependency fallback, progressive context selection.
- Phase 3 seams: TypeScript, Java, Python language plugins and React, Spring Boot, FastAPI framework plugins.
- Evaluation/security starting point: deterministic scripted provider plus runtime and traversal tests.

Next increments are deliberately isolated: AST/tree-sitter and LSP providers; actual provider adapters; durable resumable session controller; rich edit/git/test tools; MCP transports and skill loader; Docker/Podman; isolated subagents; HTTP server; Graphify; and comprehensive polyglot integration/security benchmarks. None require changing `AgentRuntime`'s public collaboration boundaries.
