import { join, resolve, relative, sep } from "node:path";
import { lstat } from "node:fs/promises";
const protectedName = (name: string) => name === ".env" || /^\.env\.(?!example$)/.test(name) || /(?:^id_rsa$|\.(?:pem|key|p12|pfx|tfvars))$/i.test(name) || /^(?:credentials|secrets?)(?:\.[\w-]+)?$/i.test(name) || [".npmrc", ".pypirc", ".netrc"].includes(name);
export class WorkspaceBoundary {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async resolveUserPath(userPath: string): Promise<string> { const candidate = resolve(this.root, userPath); if (candidate !== this.root && !candidate.startsWith(this.root + sep)) throw new Error(`Path escapes workspace: ${userPath}`); const parts = relative(this.root, candidate).split(sep).filter(Boolean); const name = parts.at(-1) ?? ""; if (parts.includes(".git")) throw new Error("Git internals are protected from agent file tools"); if (parts.some(part => [".ssh", ".aws", ".gnupg"].includes(part)) || protectedName(name)) throw new Error(`Protected secret file: ${userPath}`); let current = this.root; for (const part of parts) { current = join(current, part); const stat = await lstat(current).catch(() => undefined); if (stat?.isSymbolicLink()) throw new Error(`Symlinks are not accepted: ${relative(this.root, current)}`); } return candidate; }
}
export interface WorkspaceAccess { readonly root: string; resolveUserPath(userPath: string): Promise<string> }
/** Routes `repository:path` only across an explicit set of independently confined roots. */
export class MultiWorkspaceBoundary implements WorkspaceAccess {
  readonly root: string; private readonly boundaries: Map<string, WorkspaceBoundary>;
  constructor(roots: Record<string, string>, private readonly defaultRepository: string) { this.boundaries = new Map(Object.entries(roots).map(([id, root]) => [id, new WorkspaceBoundary(root)])); const boundary = this.boundaries.get(defaultRepository); if (!boundary) throw new Error(`Default repository is not configured: ${defaultRepository}`); this.root = boundary.root; }
  async resolveUserPath(userPath: string) { const match = userPath.match(/^([A-Za-z0-9_-]+):(.*)$/); const id = match?.[1] ?? this.defaultRepository, path = match?.[2] ?? userPath, boundary = this.boundaries.get(id); if (!boundary) throw new Error(`Repository is not configured: ${id}`); return boundary.resolveUserPath(path || "."); }
}
