import { createHash } from "node:crypto";
import { LocalSandbox } from "../../sandbox/src/index.js";
import { WorkspaceBoundary, type WorkspaceAccess } from "../../workspace/src/index.js";
import type { Sandbox } from "../../sandbox/src/index.js";
import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ExecutionUnconfirmedError, type Command } from "../../shared/src/index.js";
import type { ToolContext, ToolRegistry } from "../../tool-runtime/src/index.js";

export interface VerificationResult { passed: boolean; attempted: number; skipped: number; results: Array<{ command: Command; exitCode?: number; output: string; skipped?: boolean }> }
export interface Verifier { verify(signal?: AbortSignal): Promise<VerificationResult> }
const exists = (path: string) => access(path).then(() => true).catch(() => false);
/** Discovers only project-declared verification commands; it never invents a package-manager command. */
const verificationFiles = ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb", "pom.xml", "mvnw", "mvnw.cmd", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew", "pyproject.toml", "pytest.ini", "uv.lock"];
export async function captureVerificationSnapshot(workspace: WorkspaceAccess, sandbox: Sandbox): Promise<Record<string, string | null>> {
  const entries = await Promise.all(verificationFiles.map(async file => {
    const path = await workspace.resolveUserPath(file);
    try { return [file, createHash("sha256").update(await sandbox.readFile(path)).digest("hex")] as const; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|no such file/i.test(String(error))) return [file, null] as const; throw error; }
  }));
  return Object.fromEntries(entries);
}
export class RepositoryVerificationPlanner {
  constructor(private readonly root: string) {}
  async commands(): Promise<Command[]> {
    const commands: Command[] = [];
    for (const project of await this.projectRoots()) {
      const cwd = relative(this.root, project) || undefined;
      const packageFile = join(project, "package.json");
      if (await exists(packageFile)) {
        const pkg = JSON.parse(await readFile(packageFile, "utf8")) as { scripts?: Record<string, string> };
        const manager = await exists(join(project, "pnpm-lock.yaml")) ? "pnpm" : await exists(join(project, "yarn.lock")) ? "yarn" : await exists(join(project, "bun.lockb")) ? "bun" : "npm";
        if (pkg.scripts?.test) commands.push({ argv: manager === "npm" ? ["npm", "test"] : [manager, "test"], cwd, risk: "safe" });
        if (pkg.scripts?.build) commands.push({ argv: manager === "npm" ? ["npm", "run", "build"] : [manager, "build"], cwd, risk: "safe" });
        if (pkg.scripts?.lint) commands.push({ argv: manager === "npm" ? ["npm", "run", "lint"] : [manager, "lint"], cwd, risk: "safe" });
      }
      if (await exists(join(project, "pom.xml"))) commands.push({ argv: [await mavenExecutable(project), "test"], cwd, risk: "safe" });
      else if (await exists(join(project, "build.gradle")) || await exists(join(project, "build.gradle.kts"))) commands.push({ argv: [await exists(join(project, "gradlew")) ? "./gradlew" : "gradle", "test"], cwd, risk: "safe" });
      if (await exists(join(project, "pyproject.toml")) || await exists(join(project, "pytest.ini"))) commands.push({ argv: ["python", "-m", "pytest"], cwd, risk: "safe" });
    }
    const verificationSnapshot = await captureVerificationSnapshot(new WorkspaceBoundary(this.root), new LocalSandbox());
    return commands.map(command => ({ ...command, verificationSnapshot }));
  }
  private async projectRoots() {
    const roots: string[] = [];
    const ignored = new Set([".agent", ".git", "node_modules", "dist", "build", "target"]);
    const visit = async (directory: string, depth: number): Promise<void> => {
      roots.push(directory);
      if (depth === 4) return;
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        await Promise.all(entries.filter(entry => entry.isDirectory() && !ignored.has(entry.name)).map(entry => visit(join(directory, entry.name), depth + 1)));
      } catch { return; }
    };
    await visit(this.root, 0);
    return roots;
  }
}
async function mavenExecutable(project: string): Promise<string> {
  if (await exists(join(project, "mvnw"))) return "./mvnw";
  if (await exists(join(project, "mvnw.cmd"))) return "./mvnw.cmd";
  return "mvn";
}
export class ToolVerificationRunner implements Verifier {
  constructor(private readonly source: Command[] | (() => Promise<Command[]>), private readonly tools: ToolRegistry, private readonly context: ToolContext) { if (Array.isArray(source)) context.verificationSnapshot ??= source[0]?.verificationSnapshot; }
  async verify(signal?: AbortSignal): Promise<VerificationResult> { const commands = Array.isArray(this.source) ? this.source : await this.source(); const results: VerificationResult["results"] = []; for (const command of commands) { signal?.throwIfAborted(); try { const result = await this.tools.invoke("shell", { command }, { ...this.context, signal, verificationSnapshot: command.verificationSnapshot ?? this.context.verificationSnapshot }); results.push({ command, exitCode: result.execution?.exitCode, output: result.content.slice(-10_000) }); } catch (error) { if (error instanceof ExecutionUnconfirmedError) throw error; results.push({ command, output: String(error), skipped: true }); } } const attempted = results.filter(result => !result.skipped).length, skipped = results.filter(result => result.skipped).length; return { passed: attempted > 0 && skipped === 0 && results.every(result => result.exitCode === 0), attempted, skipped, results }; }
}
