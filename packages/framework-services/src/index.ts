import type { Command, DetectionResult, Diagnostic, Repository, Task } from "../../shared/src/index.js";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
export interface FrameworkNode { id: string; kind: string; file: string; line: number; metadata?: Record<string, string> }
export interface FrameworkModel { nodes: FrameworkNode[]; edges: Array<[string, string]> }
export interface FrameworkPlugin { id: string; language: string; detect(repository: Repository): Promise<DetectionResult>; analyze(repository: Repository): Promise<FrameworkModel>; getRelevantFiles(task: Task): Promise<string[]>; getCommands(repository: Repository): Promise<Command[]>; getDiagnostics(repository: Repository): Promise<Diagnostic[]> }
const ignored = new Set([".git", "node_modules", "dist", "build", "target", "__pycache__"]);
export async function repositoryFiles(root: string, extension: RegExp, at = root, output: string[] = []): Promise<string[]> { for (const entry of await readdir(at, { withFileTypes: true })) { if (ignored.has(entry.name)) continue; const full = join(at, entry.name); if (entry.isDirectory()) await repositoryFiles(root, extension, full, output); else if (entry.isFile() && extension.test(entry.name)) output.push(relative(root, full)); } return output; }
export async function source(root: string, file: string) { return readFile(join(root, file), "utf8").catch(() => ""); }
export function taskTerms(task: Task) { return task.prompt.toLowerCase().split(/\W+/).filter(term => term.length > 3); }
