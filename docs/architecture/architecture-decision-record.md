# Architecture decision record

## ADR-001: Re-entrant runtime with append-only events

The runtime is a bounded state machine, not an implicit `while(true)` loop. Each transition emits a typed event into a replaceable event sink, so sessions can be replayed, resumed, and audited. Budgets and max turns live in the controller rather than a provider or tool.

## ADR-002: Capability plugins, never framework conditionals

Language and framework discovery are plugin registries. The agent knows only repository knowledge and tools; React, Spring Boot, and FastAPI adapters are independently detected capabilities. This makes Graphify, LSP, and future languages additive.

## ADR-003: Policy is separate from sandboxing

The policy engine is an authorization decision point (`allow`, `ask`, `deny`). A sandbox is the enforcement point. Every built-in or MCP-originated tool must pass the same registry/policy path. A local sandbox is useful for development but is explicitly not a security boundary; Docker/Podman adapters remain replaceable implementations.

## ADR-004: Context is selected, not dumped

`ContextEngine` asks a repository knowledge provider for a map and task-relevant files, scores compact provenance-tagged items, and can expand or compact later. The local provider provides a dependable filesystem fallback; AST, LSP, and Graphify can contribute without changing the runtime.

## ADR-005: Provider independence

The model gateway normalizes text/tool-call responses and capabilities. Provider SDKs belong in adapters, never in `agent-core`.
