import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryFiles, source, taskTerms, type FrameworkPlugin, type FrameworkModel } from "../../../packages/framework-services/src/index.js";
import type { Repository, Task } from "../../../packages/shared/src/index.js";
export class ReactPlugin implements FrameworkPlugin {
  id = "react"; language = "typescript";
  async detect(repository: Repository) { const pkg = await readFile(join(repository.root, "package.json"), "utf8").catch(() => ""); const found = /"(?:react|next|remix|react-router(?:-dom)?)"/.test(pkg); return { detected: found, confidence: found ? .95 : 0, evidence: found ? ["React dependency"] : [] }; }
  async analyze(repository: Repository): Promise<FrameworkModel> { const nodes: FrameworkModel["nodes"] = []; const edges: FrameworkModel["edges"] = []; for (const file of await repositoryFiles(repository.root, /\.(tsx|jsx)$/)) { const text = await source(repository.root, file); text.split(/\r?\n/).forEach((line, index) => { const component = line.match(/(?:export\s+)?(?:default\s+)?function\s+([A-Z][\w$]*)|(?:export\s+)?const\s+([A-Z][\w$]*)\s*=/); const hook = line.match(/(?:export\s+)?(?:function|const)\s+(use[A-Z][\w$]*)/); if (component) nodes.push({ id: component[1] ?? component[2]!, kind: "component", file, line: index + 1 }); if (hook) nodes.push({ id: hook[1]!, kind: "hook", file, line: index + 1 }); for (const used of line.matchAll(/\b(use[A-Z][\w$]*)\s*\(/g)) edges.push([file, used[1]!]); }); } return { nodes, edges }; }
  async getRelevantFiles(task: Task) { const terms = taskTerms(task); const files = await repositoryFiles(task.workspace, /\.(tsx|jsx|ts|js)$/); return files.filter(file => terms.some(term => file.toLowerCase().includes(term))).slice(0, 30); }
  async getCommands(repository: Repository) { const pkg = JSON.parse(await readFile(join(repository.root, "package.json"), "utf8").catch(() => "{}")) as { scripts?: Record<string, string> }; return pkg.scripts?.test ? [{ argv: ["pnpm", "test"] }] : []; }
  async getDiagnostics() { return []; }
}
