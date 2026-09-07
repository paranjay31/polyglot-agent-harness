# Component topology

```text
CLI / Server
  -> AgentRuntime (bounded FSM + events)
     -> ModelProvider
     -> ContextEngine -> RepositoryKnowledgeProvider -> local / AST / LSP / Graphify
     -> ToolRegistry -> PolicyEngine -> Sandbox + Workspace
     -> LanguagePluginRegistry / FrameworkPlugin registry
```

The only direction into execution is `ToolRegistry`. Plugins supply information and commands but cannot bypass policy.
