import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryFiles, source, taskTerms, type FrameworkPlugin, type FrameworkModel } from "../../../packages/framework-services/src/index.js";
import type { Repository, Task } from "../../../packages/shared/src/index.js";
export class FastApiPlugin implements FrameworkPlugin {
  id = "fastapi"; language = "python";
  async detect(repository: Repository) { const config = await readFile(join(repository.root, "pyproject.toml"), "utf8").catch(() => "") + await readFile(join(repository.root, "requirements.txt"), "utf8").catch(() => ""); const found = /fastapi/.test(config); return { detected: found, confidence: found ? .95 : 0, evidence: found ? ["fastapi dependency"] : [] }; }
  async analyze(repository: Repository): Promise<FrameworkModel> { const nodes: FrameworkModel["nodes"] = []; const edges: FrameworkModel["edges"] = []; for (const file of await repositoryFiles(repository.root, /\.py$/)) { const lines = (await source(repository.root, file)).split(/\r?\n/); let endpoint: { method: string; path: string } | undefined; lines.forEach((line, index) => { const route = line.match(/@(\w+)\.(get|post|put|delete|patch)\(\s*["']([^"']+)/); if (route) endpoint = { method: route[2]!.toUpperCase(), path: route[3]! }; const fn = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\((.*)\)/); if (fn) { nodes.push({ id: fn[1]!, kind: endpoint ? "endpoint" : "function", file, line: index + 1, metadata: endpoint }); for (const dependency of fn[2]!.matchAll(/Depends\((\w+)/g)) edges.push([fn[1]!, dependency[1]!]); endpoint = undefined; } const model = line.match(/^\s*class\s+(\w+)\s*\([^)]*(?:BaseModel|SQLModel)/); if (model) nodes.push({ id: model[1]!, kind: "model", file, line: index + 1 }); }); } return { nodes, edges }; }
  async getRelevantFiles(task: Task) { const terms = taskTerms(task); const files = await repositoryFiles(task.workspace, /\.py$/); return files.filter(file => terms.some(term => file.toLowerCase().includes(term))).slice(0, 30); }
  async getCommands(repository: Repository) { return (await readFile(join(repository.root, "pyproject.toml"), "utf8").catch(() => "")) ? [{ argv: ["python", "-m", "pytest"] }] : []; }
  async getDiagnostics() { return []; }
}
