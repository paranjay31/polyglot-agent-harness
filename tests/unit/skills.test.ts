import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { SkillRegistry } from "../../packages/skills/src/index.js";
describe("skills", () => it("discovers only repository-scoped skills and requires explicit activation", async () => { const root = await mkdtemp(join(tmpdir(), "harness-skill-")); await mkdir(join(root, ".agent", "skills", "fastapi"), { recursive: true }); await writeFile(join(root, ".agent", "skills", "fastapi", "SKILL.md"), "Use dependency injection and endpoint tests for FastAPI."); expect((await new SkillRegistry(root).discover()).map(skill => skill.id)).toContain("fastapi"); expect(await new SkillRegistry(root).relevant("add a FastAPI endpoint")).toEqual([]); expect((await new SkillRegistry(root, ["fastapi"]).relevant("add a FastAPI endpoint"))[0]?.id).toBe("fastapi"); }));

it("loads root AGENTS.md as bounded repository guidance without enabling every skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-agents-")); await mkdir(join(root, "skills", "react"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Run focused tests after edits."); await writeFile(join(root, "skills", "react", "SKILL.md"), "Use React conventions.");
  const guidance = await new SkillRegistry(root).relevant("unrelated task");
  expect(guidance).toMatchObject([{ id: "AGENTS.md", instructions: "Run focused tests after edits." }]);
});
