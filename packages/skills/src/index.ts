import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
export interface Skill { id: string; path: string; instructions: string }
async function walk(root: string, at = root, output: string[] = []): Promise<string[]> { const entries = await readdir(at, { withFileTypes: true }).catch(() => []); for (const entry of entries) { const full = join(at, entry.name); if (entry.isDirectory()) await walk(root, full, output); else if (entry.isFile() && entry.name === "SKILL.md") output.push(relative(root, full)); } return output; }
/** Finds local, repository-scoped skills. Only these roots are searched; unrelated files never become instructions. */
export class SkillRegistry {
  constructor(private readonly workspace: string, private readonly enabled: string[] = []) {}
  async discover(): Promise<Skill[]> { const roots = [join(this.workspace, ".agent", "skills"), join(this.workspace, "skills")]; const skills = (await Promise.all(roots.map(async root => (await walk(root)).map(path => ({ id: path.replace(/\/SKILL\.md$/, "").replace(/\\/g, "/"), path: join(root, path) }))))).flat(); return Promise.all(skills.map(async skill => ({ ...skill, instructions: await readFile(skill.path, "utf8") }))); }
  /** Root AGENTS.md is repository guidance, not an auto-enabled skill and cannot override runtime policy. */
  async repositoryInstructions(): Promise<Skill[]> { const path = join(this.workspace, "AGENTS.md"), instructions = await readFile(path, "utf8").catch(() => ""); return instructions ? [{ id: "AGENTS.md", path, instructions: instructions.slice(0, 32_000) }] : []; }
  async relevant(task: string, max = 4): Promise<Skill[]> { const terms = task.toLowerCase().split(/\W+/).filter(term => term.length > 3); const skills = (await this.discover()).filter(skill => this.enabled.includes(skill.id)).map(skill => ({ skill, score: terms.reduce((score, term) => score + (skill.id.toLowerCase().includes(term) ? 2 : 0) + (skill.instructions.toLowerCase().includes(term) ? 1 : 0), 0) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(item => item.skill); return [...await this.repositoryInstructions(), ...skills].slice(0, max + 1); }
}
