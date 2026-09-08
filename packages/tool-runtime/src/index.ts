import { captureVerificationSnapshot } from "../../verification/src/index.js";
import { z, type ZodType } from "zod";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Command, CommandRisk, ExecutionResult } from "../../shared/src/index.js";
import type { PolicyEngine, Permission, PolicyRequest } from "../../policy/src/index.js";
import type { Sandbox } from "../../sandbox/src/index.js";
import type { WorkspaceAccess } from "../../workspace/src/index.js";
import type { RepositoryKnowledgeProvider } from "../../repository/src/index.js";
import type { LanguageServer } from "../../language-services/src/index.js";
export interface ToolContext { preparedCommand?: Command; signal?: AbortSignal; verificationSnapshot?: Record<string, string | null>; workspace: WorkspaceAccess; sandbox: Sandbox; policy: PolicyEngine; knowledge?: RepositoryKnowledgeProvider; languageServer?: LanguageServer; approve?: (request: PolicyRequest & { tool: string; input: unknown }) => Promise<boolean> }
export interface ToolResult { content: string; data?: unknown; execution?: ExecutionResult }
export interface Tool<I = unknown> { name: string; description: string; inputSchema: ZodType<I>; modelSchema?: object; permission: Permission; risk?: CommandRisk; prepareCommand?(input: I, context: ToolContext): Promise<Command>; execute(input: I, context: ToolContext): Promise<ToolResult> }
function classifyCommand(command: Command): Command["risk"] {
  const [program, ...args] = command.argv;
  const joined = args.join(" ");
  if (["rm", "sudo", "curl", "wget", "ssh", "docker", "podman"].includes(program ?? "")) return "potentially_destructive";
  if (program === "git" && !/^(status|diff|log|show|branch)(\s|$)/.test(joined)) return "potentially_destructive";
  if (program === "pnpm" || program === "npm" || program === "yarn" || program === "bun") return /^(test|run (test|build|lint|format)|build|lint)(\s|$)/.test(joined) ? "safe" : "potentially_destructive";
  if (program === "mvn" || program === "gradle" || program === "./gradlew") return /^(test|package|build)(\s|$)/.test(joined) ? "safe" : "potentially_destructive";
  if (program === "pytest" || (program === "python" && /^-m pytest(\s|$)/.test(joined))) return "safe";
  return "potentially_destructive";
}
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  register(tool: Tool) { if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`); this.tools.set(tool.name, tool); }
  has(name: string) { return this.tools.has(name); }
  definitions() { return [...this.tools.values()].map(({ name, description, modelSchema }) => ({ name, description, inputSchema: modelSchema ?? { type: "object" } })); }
  /** Read-only calls can be grouped by the runtime without reordering mutations. */
  isReadOnly(name: string) { return this.tools.get(name)?.permission === "read"; }
  /** Creates a capability-limited view for an isolated child run. */
  scoped(allowed: readonly string[]) { const scoped = new ToolRegistry(); for (const name of allowed) { const tool = this.tools.get(name); if (tool) scoped.register(tool); } return scoped; }
  async invoke(name: string, rawInput: unknown, context: ToolContext): Promise<ToolResult> {
    context.signal?.throwIfAborted();
    const tool = this.tools.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`);
    const input = tool.inputSchema.parse(rawInput);
    const command = tool.prepareCommand ? await tool.prepareCommand(input, context) : (input as { command?: Command }).command;
    let risk = name === "shell" && command ? classifyCommand(command) : tool.risk;
    let reason: string | undefined;
    let current: Record<string, string | null> | undefined;
    if (/^run_(test|build|lint|format)$/.test(name) || (name === "shell" && risk === "safe")) {
      current = await captureVerificationSnapshot(context.workspace, context.sandbox);
      const unchanged = context.verificationSnapshot && JSON.stringify(current) === JSON.stringify(context.verificationSnapshot);
      if (!context.sandbox.isolated || !unchanged) {
        risk = "potentially_destructive";
        reason = !unchanged ? "Verification definitions changed or were not snapshotted; review the current scripts before approving." : "Repository programs execute on the host with its filesystem and environment access.";
      }
    }
    const request = { permission: tool.permission, risk, target: command ? command.argv.join(" ") : name };
    const decision = context.policy.decide(request);
    if (decision === "deny") throw new Error(`Policy deny: ${tool.permission} for ${name}`);
    if (decision === "ask" && !(await context.approve?.({ ...request, tool: name, input: { action: input, command, workspace: context.workspace.root, reason, verificationDefinitions: current } }))) throw new Error(`Policy ask: ${tool.permission} for ${name}${reason ? `: ${reason}` : ""}`);
    context.signal?.throwIfAborted();
    if (current && JSON.stringify(await captureVerificationSnapshot(context.workspace, context.sandbox)) !== JSON.stringify(current)) throw new Error("Verification definitions changed during authorization; retry and review them again");
    return tool.execute(input, { ...context, preparedCommand: command });
  }
}
export function registerBuiltinTools(registry: ToolRegistry) {
  const knowledge = (ctx: ToolContext) => { if (!ctx.knowledge) throw new Error("Repository knowledge provider is unavailable"); return ctx.knowledge; };
  const languageServer = (ctx: ToolContext) => { if (!ctx.languageServer) throw new Error("Language server is unavailable"); return ctx.languageServer; };
  const globRegex = (pattern: string) => {
    let expression = "";
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index]!;
      if (character === "*" && pattern[index + 1] === "*") { const directoryWildcard = pattern[index + 2] === "/"; expression += directoryWildcard ? "(?:.*/)?" : ".*"; index += directoryWildcard ? 2 : 1; }
      else if (character === "*") expression += "[^/]*";
      else if (character === "?") expression += "[^/]";
      else expression += /[\\^$+?.()|{}\[\]]/.test(character) ? `\\${character}` : character;
    }
    return new RegExp(`^${expression}$`, "i");
  };
  const declaredScript = async (ctx: ToolContext, script: "test" | "build" | "lint" | "format") => {
    const file = async (name: string) => ctx.workspace.resolveUserPath(name).then(path => ctx.sandbox.readFile(path)).catch(() => undefined);
    const raw = await file("package.json");
    if (raw) {
      const pkg = JSON.parse(raw.toString("utf8")) as { scripts?: Record<string, string>; packageManager?: string };
      if (pkg.scripts?.[script]) { const manager = pkg.packageManager?.split("@")[0] ?? "npm"; return manager === "npm" ? ["npm", script === "test" ? "test" : "run", ...(script === "test" ? [] : [script])] : [manager, script]; }
    }
    const maven = await file("pom.xml");
    const gradle = await file("build.gradle") ?? await file("build.gradle.kts");
    const pyproject = await file("pyproject.toml");
    const pytest = await file("pytest.ini");
    if (script === "test") {
      if (maven) return ["mvn", "test"];
      if (gradle) return [await file("gradlew") ? "./gradlew" : "gradle", "test"];
      if (pyproject || pytest) return await file("uv.lock") ? ["uv", "run", "pytest"] : ["python", "-m", "pytest"];
    }
    if (script === "build") {
      if (maven) return ["mvn", "package", "-DskipTests"];
      if (gradle) return [await file("gradlew") ? "./gradlew" : "gradle", "build", "-x", "test"];
      if (pyproject) return ["python", "-m", "build"];
    }
    const project = maven ? "Maven" : gradle ? "Gradle" : pyproject || pytest ? "Python" : "this";
    throw new Error(`Project does not declare a ${script} command (${project} project)`);
  };
  const hunk = (text: string) => {
    const old: string[] = [], next: string[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) continue;
      if (line.startsWith(" ")) { old.push(line.slice(1)); next.push(line.slice(1)); }
      else if (line.startsWith("-")) old.push(line.slice(1));
      else if (line.startsWith("+")) next.push(line.slice(1));
      else if (line) throw new Error(`Unsupported patch line: ${line}`);
    }
    return { old: old.join("\n"), next: next.join("\n") };
  };
  const hunks = (text: string) => {
    const parts = text.split(/^@@[^\n]*\n?/m).filter(part => part.trim());
    return (parts.length ? parts : [text]).map(hunk);
  };
  registry.register({ name: "list_directory", description: "List a directory inside the workspace (non-recursive).", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }, inputSchema: z.object({ path: z.string().optional().default(".") }), async execute({ path }, ctx) { const full = await ctx.workspace.resolveUserPath(path); const entries = await readdir(full, { withFileTypes: true }); return { content: entries.map(entry => `${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`).join("\n"), data: { path: relative(ctx.workspace.root, full).replaceAll("\\", "/"), count: entries.length } }; } });
  registry.register({ name: "read_file", description: "Read a UTF-8 file inside the workspace", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, inputSchema: z.object({ path: z.string() }), async execute({ path }, ctx) { const full = await ctx.workspace.resolveUserPath(path); const content = (await ctx.sandbox.readFile(full)).toString("utf8"); return { content, data: { path, bytes: Buffer.byteLength(content) } }; } });
  registry.register({ name: "write_file", description: "Write a complete UTF-8 file inside the workspace. Read first; do not overwrite unrelated content.", permission: "write", modelSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }, inputSchema: z.object({ path: z.string(), content: z.string() }), async execute({ path, content }, ctx) { const full = await ctx.workspace.resolveUserPath(path); await ctx.sandbox.writeFile(full, Buffer.from(content)); await ctx.languageServer?.refresh(full).catch(() => undefined); ctx.knowledge?.invalidate?.(); return { content: `Wrote ${path}` }; } });
  registry.register({ name: "edit_file", description: "Make one exact replacement in an existing UTF-8 file. Always read the file first and use a unique oldText.", permission: "edit", modelSchema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"], additionalProperties: false }, inputSchema: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }), async execute({ path, oldText, newText }, ctx) { const full = await ctx.workspace.resolveUserPath(path); const content = (await ctx.sandbox.readFile(full)).toString("utf8"); const count = content.split(oldText).length - 1; if (count !== 1) throw new Error(`edit_file requires exactly one match; found ${count} in ${path}`); await ctx.sandbox.writeFile(full, Buffer.from(content.replace(oldText, newText))); await ctx.languageServer?.refresh(full).catch(() => undefined); ctx.knowledge?.invalidate?.(); return { content: `Edited ${path}` }; } });
  registry.register({ name: "apply_patch", description: "Apply an exact Begin Patch update/add patch inside the workspace. Patches must have unique matching hunks.", permission: "edit", modelSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false }, inputSchema: z.object({ patch: z.string().min(1).max(200_000) }), async execute({ patch }: { patch: string }, ctx) {
    if (!patch.startsWith("*** Begin Patch\n") || !patch.trimEnd().endsWith("*** End Patch")) throw new Error("Patch must use *** Begin Patch / *** End Patch markers");
    const body = patch.trim().replace(/^\*\*\* Begin Patch\n?/, "").replace(/\n?\*\*\* End Patch$/, "");
    const sections = body.split(/(?=\*\*\* (?:Update|Add) File: )/).filter(Boolean);
    if (!sections.length) throw new Error("Patch contains no supported file sections");
    const writes: Array<{ path: string; full: string; content: Buffer }> = [];
    for (const section of sections) {
      const match = section.match(/^\*\*\* (Update|Add) File: ([^\n]+)\n([\s\S]*)$/);
      if (!match) throw new Error("Invalid patch section");
      const [, kind, path, content] = match;
      const full = await ctx.workspace.resolveUserPath(path);
      if (writes.some(write => write.full === full)) throw new Error(`Patch changes ${path} more than once`);
      if (kind === "Add") {
        if (await ctx.sandbox.readFile(full).then(() => true).catch(() => false)) throw new Error(`Add File already exists: ${path}`);
        const lines = content.split("\n");
        if (lines.some(line => line && !line.startsWith("+"))) throw new Error(`Invalid add-file content in ${path}`);
        writes.push({ path, full, content: Buffer.from(lines.filter(line => line.startsWith("+")).map(line => line.slice(1)).join("\n")) });
        continue;
      }
      let next = (await ctx.sandbox.readFile(full)).toString("utf8");
      for (const parsed of hunks(content)) {
        const count = parsed.old ? next.split(parsed.old).length - 1 : 0;
        if (count !== 1) throw new Error(`Patch hunk requires exactly one match in ${path}; found ${count}`);
        next = next.replace(parsed.old, parsed.next);
      }
      writes.push({ path, full, content: Buffer.from(next) });
    }
    for (const write of writes) { await ctx.sandbox.writeFile(write.full, write.content); await ctx.languageServer?.refresh(write.full).catch(() => undefined); }
    ctx.knowledge?.invalidate?.();
    const changed = writes.map(write => write.path);
    return { content: `Patched ${changed.join(", ")}`, data: { changed } };
  } });
  registry.register({ name: "repository_map", description: "Get a compact map of repository files and byte sizes.", permission: "read", modelSchema: { type: "object", properties: { maxFiles: { type: "number" } }, additionalProperties: false }, inputSchema: z.object({ maxFiles: z.number().int().positive().max(2000).optional() }), async execute({ maxFiles }, ctx) { const map = await knowledge(ctx).getRepositoryMap({ maxFiles }); return { content: JSON.stringify(map), data: map }; } });
  registry.register({ name: "search_code", description: "Search repository text case-insensitively and return matching lines.", permission: "read", modelSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"], additionalProperties: false }, inputSchema: z.object({ query: z.string().min(1), maxResults: z.number().int().positive().max(200).optional() }), async execute({ query, maxResults }, ctx) { const matches = await knowledge(ctx).search({ text: query, maxResults }); return { content: JSON.stringify(matches), data: matches }; } });
  for (const name of ["search", "grep"] as const) registry.register({ name, description: "Search repository text case-insensitively and return matching lines.", permission: "read", modelSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"], additionalProperties: false }, inputSchema: z.object({ query: z.string().min(1), maxResults: z.number().int().positive().max(200).optional() }), async execute({ query, maxResults }, ctx) { const matches = await knowledge(ctx).search({ text: query, maxResults }); return { content: JSON.stringify(matches), data: matches }; } });
  registry.register({ name: "glob", description: "Find repository files using a case-insensitive glob pattern such as src/**/*.ts.", permission: "read", modelSchema: { type: "object", properties: { pattern: { type: "string" }, maxResults: { type: "number" } }, required: ["pattern"], additionalProperties: false }, inputSchema: z.object({ pattern: z.string().min(1).max(500), maxResults: z.number().int().positive().max(2_000).optional().default(200) }), async execute({ pattern, maxResults }, ctx) { const expression = globRegex(pattern.replaceAll("\\", "/")); const files = (await knowledge(ctx).getRepositoryMap({ maxFiles: 20_000 })).files.filter(file => expression.test(file.path.replaceAll("\\", "/"))).slice(0, maxResults); return { content: JSON.stringify(files), data: files }; } });
  registry.register({ name: "find_files", description: "Find repository files whose paths contain a case-insensitive query.", permission: "read", modelSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"], additionalProperties: false }, inputSchema: z.object({ query: z.string().min(1), maxResults: z.number().int().positive().max(500).optional().default(100) }), async execute({ query, maxResults }, ctx) { const map = await knowledge(ctx).getRepositoryMap({ maxFiles: 10_000 }); const files = map.files.filter(file => file.path.toLowerCase().includes(query.toLowerCase())).slice(0, maxResults); return { content: JSON.stringify(files), data: files }; } });
  registry.register({ name: "find_symbol", description: "Find indexed declarations by optional name substring.", permission: "read", modelSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false }, inputSchema: z.object({ name: z.string().optional() }), async execute({ name }, ctx) { const symbols = await knowledge(ctx).getSymbols({ name }); return { content: JSON.stringify(symbols.slice(0, 100)), data: symbols }; } });
  registry.register({ name: "find_references", description: "Find textual references to a symbol or identifier.", permission: "read", modelSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false }, inputSchema: z.object({ target: z.string().min(1) }), async execute({ target }, ctx) { const references = await knowledge(ctx).getReferences(target); return { content: JSON.stringify(references), data: references }; } });
  registry.register({ name: "get_dependencies", description: "Get imports/dependencies declared by a repository-relative source file.", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, inputSchema: z.object({ path: z.string() }), async execute({ path }, ctx) { await ctx.workspace.resolveUserPath(path); const graph = await knowledge(ctx).getDependencies(path); return { content: JSON.stringify(graph), data: graph }; } });
  registry.register({ name: "get_diagnostics", description: "Get language diagnostics for selected repository-relative files, when language plugins are available.", permission: "read", modelSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, additionalProperties: false }, inputSchema: z.object({ paths: z.array(z.string()).max(100).optional() }), async execute({ paths }: { paths?: string[] }, ctx) { if (paths) await Promise.all(paths.map(path => ctx.workspace.resolveUserPath(path))); const provider = knowledge(ctx); if (!provider.getDiagnostics) throw new Error("Language diagnostics are unavailable"); const diagnostics = await provider.getDiagnostics(paths); return { content: JSON.stringify(diagnostics), data: diagnostics }; } });
  const location = z.object({ path: z.string(), line: z.number().int().positive(), column: z.number().int().positive() });
  registry.register({ name: "lsp_definition", description: "Resolve an LSP definition at a repository-relative source location.", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, column: { type: "number" } }, required: ["path", "line", "column"] }, inputSchema: location, async execute({ path, line, column }, ctx) { const file = await ctx.workspace.resolveUserPath(path); const result = await languageServer(ctx).definition({ file, line, column }); return { content: JSON.stringify(result), data: result }; } });
  registry.register({ name: "lsp_references", description: "Resolve LSP references at a repository-relative source location.", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, column: { type: "number" } }, required: ["path", "line", "column"] }, inputSchema: location, async execute({ path, line, column }, ctx) { const file = await ctx.workspace.resolveUserPath(path); const result = await languageServer(ctx).references({ file, line, column }); return { content: JSON.stringify(result), data: result }; } });
  registry.register({ name: "lsp_hover", description: "Get LSP hover information at a repository-relative source location.", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, column: { type: "number" } }, required: ["path", "line", "column"] }, inputSchema: location, async execute({ path, line, column }, ctx) { const file = await ctx.workspace.resolveUserPath(path); const result = await languageServer(ctx).hover({ file, line, column }); return { content: JSON.stringify(result), data: result }; } });
  registry.register({ name: "lsp_symbols", description: "Get LSP document symbols for a repository-relative source file.", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, inputSchema: z.object({ path: z.string() }), async execute({ path }, ctx) { const result = await languageServer(ctx).symbols(await ctx.workspace.resolveUserPath(path)); return { content: JSON.stringify(result), data: result }; } });
  registry.register({ name: "lsp_diagnostics", description: "Get LSP diagnostics for a repository-relative source file.", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, inputSchema: z.object({ path: z.string() }), async execute({ path }, ctx) { const result = await languageServer(ctx).diagnostics(await ctx.workspace.resolveUserPath(path)); return { content: JSON.stringify(result), data: result }; } });
  for (const script of ["test", "build", "lint", "format"] as const) registry.register({ name: `run_${script}`, description: `Run the project-declared ${script} script without constructing a shell command.`, permission: script === "format" ? "edit" : "shell", risk: script === "format" ? "potentially_destructive" : "safe", modelSchema: { type: "object", properties: {}, additionalProperties: false }, inputSchema: z.object({}), prepareCommand: async (_input, ctx) => ({ argv: await declaredScript(ctx, script), cwd: ctx.workspace.root }), async execute(_input, ctx) { const execution = await ctx.sandbox.execute({ ...ctx.preparedCommand!, signal: ctx.signal }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_status", description: "Read the current Git working-tree status.", permission: "read", modelSchema: { type: "object", properties: {}, additionalProperties: false }, inputSchema: z.object({}), async execute(_input, ctx) { const execution = await ctx.sandbox.execute({ argv: ["git", "status", "--short"], cwd: ctx.workspace.root, signal: ctx.signal, risk: "safe" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_branch", description: "List local and current Git branches without changing the repository.", permission: "read", modelSchema: { type: "object", properties: {}, additionalProperties: false }, inputSchema: z.object({}), async execute(_input, ctx) { const execution = await ctx.sandbox.execute({ argv: ["git", "branch", "--no-color"], cwd: ctx.workspace.root, signal: ctx.signal, risk: "safe" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_diff", description: "Read the unstaged Git diff; optional path is workspace-relative.", permission: "read", modelSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }, inputSchema: z.object({ path: z.string().optional() }), async execute({ path }, ctx) { if (path) await ctx.workspace.resolveUserPath(path); const execution = await ctx.sandbox.execute({ argv: path ? ["git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--", path] : ["git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv"], cwd: ctx.workspace.root, signal: ctx.signal, risk: "safe" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_log", description: "Read recent Git commits without changing the repository.", permission: "read", modelSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false }, inputSchema: z.object({ limit: z.number().int().positive().max(100).optional().default(10) }), async execute({ limit }, ctx) { const execution = await ctx.sandbox.execute({ argv: ["git", "log", `-${limit}`, "--oneline"], cwd: ctx.workspace.root, signal: ctx.signal, risk: "safe" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_show", description: "Read a Git revision or file at a revision without changing the repository.", permission: "read", modelSchema: { type: "object", properties: { revision: { type: "string" } }, required: ["revision"], additionalProperties: false }, inputSchema: z.object({ revision: z.string().min(1).max(500).regex(/^(?!-)/, "Git revisions cannot begin with a dash") }), async execute({ revision }, ctx) { const execution = await ctx.sandbox.execute({ argv: ["git", "--no-pager", "show", "--no-ext-diff", "--no-textconv", "--stat", "--oneline", "--end-of-options", revision], cwd: ctx.workspace.root, signal: ctx.signal, risk: "safe" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_switch", description: "Switch to an existing Git branch after explicit approval. Inspect status and diff first.", permission: "git", risk: "potentially_destructive", modelSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"], additionalProperties: false }, inputSchema: z.object({ branch: z.string().min(1).max(300).regex(/^(?!-)/, "Branch names cannot begin with a dash") }), async execute({ branch }: { branch: string }, ctx) { const execution = await ctx.sandbox.execute({ argv: ["git", "switch", branch], cwd: ctx.workspace.root, signal: ctx.signal, risk: "potentially_destructive" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_checkout", description: "Check out an existing Git ref after explicit approval. Inspect status and diff first.", permission: "git", risk: "potentially_destructive", modelSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false }, inputSchema: z.object({ target: z.string().min(1).max(300).regex(/^(?!-)/, "Git refs cannot begin with a dash") }), async execute({ target }: { target: string }, ctx) { const execution = await ctx.sandbox.execute({ argv: ["git", "checkout", target], cwd: ctx.workspace.root, signal: ctx.signal, risk: "potentially_destructive" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_restore", description: "Restore explicitly named workspace-relative files after explicit approval. This discards their uncommitted changes.", permission: "git", risk: "destructive", modelSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"], additionalProperties: false }, inputSchema: z.object({ paths: z.array(z.string()).min(1).max(100) }), async execute({ paths }: { paths: string[] }, ctx) { await Promise.all(paths.map(path => ctx.workspace.resolveUserPath(path))); const execution = await ctx.sandbox.execute({ argv: ["git", "restore", "--", ...paths], cwd: ctx.workspace.root, signal: ctx.signal, risk: "destructive" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "git_commit", description: "Create a commit for explicit workspace-relative paths only. Always inspect status and diff first.", permission: "git", risk: "potentially_destructive", modelSchema: { type: "object", properties: { message: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["message", "paths"], additionalProperties: false }, inputSchema: z.object({ message: z.string().min(1).max(200), paths: z.array(z.string()).min(1) }), async execute({ message, paths }: { message: string; paths: string[] }, ctx) { await Promise.all(paths.map((path: string) => ctx.workspace.resolveUserPath(path))); const add = await ctx.sandbox.execute({ argv: ["git", "add", "--", ...paths], cwd: ctx.workspace.root, signal: ctx.signal, risk: "potentially_destructive" }); if (add.exitCode !== 0) return { content: add.stdout + add.stderr, execution: add }; const execution = await ctx.sandbox.execute({ argv: ["git", "commit", "-m", message, "--", ...paths], cwd: ctx.workspace.root, signal: ctx.signal, risk: "potentially_destructive" }); return { content: execution.stdout + execution.stderr, execution }; } });
  registry.register({ name: "shell", description: "Run a discovered workspace command; never use a shell string, only argv.", permission: "shell", modelSchema: { type: "object", properties: { command: { type: "object", properties: { argv: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, required: ["argv"], additionalProperties: false } }, required: ["command"], additionalProperties: false }, inputSchema: z.object({ command: z.object({ argv: z.array(z.string()).min(1), cwd: z.string().optional(), timeoutMs: z.number().int().min(1).max(600_000).optional() }) }), async execute({ command }, ctx) { const cwd = command.cwd ? await ctx.workspace.resolveUserPath(command.cwd) : ctx.workspace.root; const execution = await ctx.sandbox.execute({ ...command, cwd, signal: ctx.signal, risk: classifyCommand(command) }); return { content: execution.stdout + execution.stderr, execution }; } });
}
