import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { appendFile, mkdir, readFile, realpath, rmdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, EventSink } from "../../protocol/src/index.js";
export class JsonlSessionStore implements EventSink {
  constructor(private readonly directory: string) {}
  async append(event: AgentEvent) { await mkdir(this.directory, { recursive: true }); await appendFile(join(this.directory, `${event.sessionId}.jsonl`), JSON.stringify(event) + "\n"); }
  async replay(sessionId: string): Promise<AgentEvent[]> { const text = await readFile(join(this.directory, `${sessionId}.jsonl`), "utf8").catch(() => ""); return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : []; }
}

/** Cross-process ownership: all attached roots must be acquired before any run starts. */
export async function acquireWorkspaceLease(roots: string[]): Promise<() => Promise<void>> {
  const directories: string[] = [];
  const release = async () => { for (const directory of directories.reverse()) { await unlink(join(directory, "owner.json")); await rmdir(directory); } };
  try {
    for (const root of [...new Set(await Promise.all(roots.map(root => realpath(root))))].sort()) {
      const key = createHash("sha256").update(root).digest("hex");
      const directory = join(tmpdir(), `polyglot-agent-lock-${key}`);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Workspace is already owned by another run: ${root}. Lock: ${directory}`); throw error; }
      await writeFile(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, root, started: new Date().toISOString() }), { mode: 0o600 });
      directories.push(directory);
    }
    return release;
  } catch (error) { await release(); throw error; }
}
