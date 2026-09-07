import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "../../shared/src/index.js";
import type { ToolContext, ToolRegistry } from "../../tool-runtime/src/index.js";

export interface VerificationResult { passed: boolean; attempted: number; skipped: number; results: Array<{ command: Command; exitCode?: number; output: string; skipped?: boolean }> }
export interface Verifier { verify(): Promise<VerificationResult> }
const exists = (path: string) => access(path).then(() => true).catch(() => false);
/** Discovers only project-declared verification commands; it never invents a package-manager command. */
export class RepositoryVerificationPlanner {
  constructor(private readonly root: string) {}
  async commands(): Promise<Command[]> {
    const commands: Command[] = []; const packageFile = join(this.root, "package.json");
    if (await exists(packageFile)) { const pkg = JSON.parse(await readFile(packageFile, "utf8")) as { scripts?: Record<string, string> }; const manager = await exists(join(this.root, "pnpm-lock.yaml")) ? "pnpm" : await exists(join(this.root, "yarn.lock")) ? "yarn" : await exists(join(this.root, "bun.lockb")) ? "bun" : "npm"; if (pkg.scripts?.test) commands.push({ argv: manager === "npm" ? ["npm", "test"] : [manager, "test"], risk: "safe" }); if (pkg.scripts?.build) commands.push({ argv: manager === "npm" ? ["npm", "run", "build"] : [manager, "build"], risk: "safe" }); if (pkg.scripts?.lint) commands.push({ argv: manager === "npm" ? ["npm", "run", "lint"] : [manager, "lint"], risk: "safe" }); }
    if (await exists(join(this.root, "pom.xml"))) commands.push({ argv: ["mvn", "test"], risk: "safe" }); else if (await exists(join(this.root, "build.gradle")) || await exists(join(this.root, "build.gradle.kts"))) commands.push({ argv: [await exists(join(this.root, "gradlew")) ? "./gradlew" : "gradle", "test"], risk: "safe" });
    if (await exists(join(this.root, "pyproject.toml")) || await exists(join(this.root, "pytest.ini"))) commands.push({ argv: ["python", "-m", "pytest"], risk: "safe" });
    return commands;
  }
}
export class ToolVerificationRunner implements Verifier {
  constructor(private readonly commands: Command[], private readonly tools: ToolRegistry, private readonly context: ToolContext) {}
  async verify(): Promise<VerificationResult> { const results: VerificationResult["results"] = []; for (const command of this.commands) { try { const result = await this.tools.invoke("shell", { command }, this.context); results.push({ command, exitCode: result.execution?.exitCode, output: result.content.slice(-10_000) }); } catch (error) { results.push({ command, output: String(error), skipped: true }); } } const attempted = results.filter(result => !result.skipped).length, skipped = results.filter(result => result.skipped).length; return { passed: attempted > 0 && skipped === 0 && results.every(result => result.exitCode === 0), attempted, skipped, results }; }
}
