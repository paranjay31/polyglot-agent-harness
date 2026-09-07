import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulePolicyEngine } from "../../packages/policy/src/index.js";
import { LocalSandbox } from "../../packages/sandbox/src/index.js";
import { ToolRegistry, registerBuiltinTools } from "../../packages/tool-runtime/src/index.js";
import { WorkspaceBoundary } from "../../packages/workspace/src/index.js";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe("apply_patch", () => {
  it("requires approval, then atomically updates and adds files", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-patch-"));
    await writeFile(join(root, "note.txt"), "before\n");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const context = { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: new RulePolicyEngine({ edit: "ask" }) };
    const input = { patch: patch("*** Update File: note.txt\n@@\n-before\n+after\n*** Add File: new.txt\n+created") };

    await expect(registry.invoke("apply_patch", input, context)).rejects.toThrow("Policy ask");
    await registry.invoke("apply_patch", input, { ...context, approve: async () => true });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created");
  });

  it("preflights all hunks before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-patch-"));
    await writeFile(join(root, "first.txt"), "before\n");
    await writeFile(join(root, "second.txt"), "unchanged\n");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const context = { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: new RulePolicyEngine() };
    const input = { patch: patch("*** Update File: first.txt\n-before\n+after\n*** Update File: second.txt\n-missing\n+replacement") };

    await expect(registry.invoke("apply_patch", input, context)).rejects.toThrow("requires exactly one match");
    expect(await readFile(join(root, "first.txt"), "utf8")).toBe("before\n");
  });

  it("applies multiple exact hunks to one file", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-patch-"));
    await writeFile(join(root, "note.txt"), "first\nkeep\nsecond\n");
    const registry = new ToolRegistry(); registerBuiltinTools(registry);
    const context = { workspace: new WorkspaceBoundary(root), sandbox: new LocalSandbox(), policy: new RulePolicyEngine() };
    await registry.invoke("apply_patch", { patch: patch("*** Update File: note.txt\n@@ one\n-first\n+updated-first\n@@ two\n-second\n+updated-second") }, context);
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("updated-first\nkeep\nupdated-second\n");
  });
});
