import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulePolicyEngine } from "../../packages/policy/src/index.js";
import { InMemoryEventSink } from "../../packages/protocol/src/index.js";
import { LocalRepositoryKnowledgeProvider } from "../../packages/repository/src/index.js";
import { LocalSandbox } from "../../packages/sandbox/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";

describe("standard discovery tools", () => {
  it("exposes search, grep, and workspace-confined glob through the tool registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-discovery-"));
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "nested", "value.ts"), "export const value = 1;\n");
    await writeFile(join(root, "src", "other.js"), "export const other = 2;\n");
    const registry = new ToolRegistry(); registerBuiltinTools(registry);
    const context = { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: new RulePolicyEngine(), knowledge: new LocalRepositoryKnowledgeProvider({ root }) };
    expect((await registry.invoke("search", { query: "value" }, context)).content).toContain("value.ts");
    expect((await registry.invoke("grep", { query: "other" }, context)).content).toContain("other.js");
    const files = JSON.parse((await registry.invoke("glob", { pattern: "src/**/*.ts" }, context)).content) as Array<{ path: string }>;
    expect(files.map(file => file.path)).toEqual(["src/nested/value.ts"]);
  });
});
