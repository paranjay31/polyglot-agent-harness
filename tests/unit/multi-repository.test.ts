import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRepositoryKnowledgeProvider } from "../../packages/repository/src/index.js";
import { MultiRepositoryKnowledgeProvider } from "../../packages/repository-intelligence/src/index.js";
describe("multi-repository knowledge", () => it("namespaces maps, symbols, and dependencies by configured repository", async () => { const web = await mkdtemp(join(tmpdir(), "harness-web-")), api = await mkdtemp(join(tmpdir(), "harness-api-")); await writeFile(join(web, "App.ts"), "export function WebApp() {}\n"); await writeFile(join(api, "service.py"), "from core import value\ndef handler(): pass\n"); const provider = new MultiRepositoryKnowledgeProvider({ web: new LocalRepositoryKnowledgeProvider({ root: web }), api: new LocalRepositoryKnowledgeProvider({ root: api }) }, "web"); expect((await provider.getRepositoryMap()).files.map(file => file.path)).toEqual(expect.arrayContaining(["web:App.ts", "api:service.py"])); expect((await provider.getSymbols({ name: "handler" })).map(symbol => symbol.file)).toContain("api:service.py"); expect((await provider.getDependencies("api:service.py")).target).toBe("api:service.py"); }));
