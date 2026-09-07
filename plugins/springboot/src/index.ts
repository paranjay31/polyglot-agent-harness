import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryFiles, source, taskTerms, type FrameworkPlugin, type FrameworkModel } from "../../../packages/framework-services/src/index.js";
import type { Repository, Task } from "../../../packages/shared/src/index.js";
export class SpringBootPlugin implements FrameworkPlugin {
  id = "springboot"; language = "java";
  async detect(repository: Repository) { const config = await readFile(join(repository.root, "pom.xml"), "utf8").catch(() => "") + await readFile(join(repository.root, "build.gradle"), "utf8").catch(() => ""); const found = /spring-boot/.test(config); return { detected: found, confidence: found ? .95 : 0, evidence: found ? ["spring-boot dependency"] : [] }; }
  async analyze(repository: Repository): Promise<FrameworkModel> { const nodes: FrameworkModel["nodes"] = []; const edges: FrameworkModel["edges"] = []; for (const file of await repositoryFiles(repository.root, /\.java$/)) { const lines = (await source(repository.root, file)).split(/\r?\n/); let stereotype: string | undefined; lines.forEach((line, index) => { const annotation = line.match(/@(RestController|Controller|Service|Repository|Entity|Configuration)\b/); if (annotation) stereotype = annotation[1]; const clazz = line.match(/\b(?:class|interface|record)\s+(\w+)/); if (clazz) nodes.push({ id: clazz[1]!, kind: stereotype?.toLowerCase() ?? "java", file, line: index + 1 }); const mapping = line.match(/@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(\s*["']([^"']+))?/); if (mapping) nodes.push({ id: `${file}:${index + 1}`, kind: "endpoint", file, line: index + 1, metadata: { method: mapping[1]!.toUpperCase(), path: mapping[2] ?? "/" } }); const injected = line.match(/private\s+(\w+)\s+\w+\s*;/); if (injected) edges.push([file, injected[1]!]); }); } return { nodes, edges }; }
  async getRelevantFiles(task: Task) { const terms = taskTerms(task); const files = await repositoryFiles(task.workspace, /\.(java|ya?ml|properties)$/); return files.filter(file => terms.some(term => file.toLowerCase().includes(term))).slice(0, 30); }
  async getCommands(repository: Repository) { return (await readFile(join(repository.root, "pom.xml"), "utf8").catch(() => "")) ? [{ argv: ["mvn", "test"] }] : [{ argv: ["gradle", "test"] }]; }
  async getDiagnostics() { return []; }
}
