import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeScriptPlugin } from "../../plugins/typescript/src/index.js";

describe("TypeScript package-manager discovery", () => {
  it("uses declared package managers for build and test commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-ts-plugin-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.2.0" }));
    const plugin = new TypeScriptPlugin();
    expect(await plugin.getBuildCommands({ root })).toEqual([{ argv: ["yarn", "build"] }]);
    expect(await plugin.getTestCommands({ root })).toEqual([{ argv: ["yarn", "test"] }]);
  });
});
