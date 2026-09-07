import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { LocalSandbox } from "../../packages/sandbox/src/index.js";
describe("atomic workspace writes", () => it("replaces a file without leaving a temporary artifact", async () => { const root = await mkdtemp(join(tmpdir(), "harness-atomic-")); const file = join(root, "source.ts"); await writeFile(file, "before"); await new LocalSandbox().writeFile(file, Buffer.from("after")); expect(await readFile(file, "utf8")).toBe("after"); expect((await (await import("node:fs/promises")).readdir(root)).filter(name => name.endsWith(".agent-write"))).toEqual([]); }));

it("creates missing parent directories only for the explicit write target", async () => { const root = await mkdtemp(join(tmpdir(), "harness-atomic-")); const file = join(root, "src", "generated", "source.ts"); await new LocalSandbox().writeFile(file, Buffer.from("export {};")); expect(await readFile(file, "utf8")).toBe("export {};"); });
