import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, EventSink } from "../../protocol/src/index.js";
export class JsonlSessionStore implements EventSink {
  constructor(private readonly directory: string) {}
  async append(event: AgentEvent) { await mkdir(this.directory, { recursive: true }); await appendFile(join(this.directory, `${event.sessionId}.jsonl`), JSON.stringify(event) + "\n"); }
  async replay(sessionId: string): Promise<AgentEvent[]> { const text = await readFile(join(this.directory, `${sessionId}.jsonl`), "utf8").catch(() => ""); return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : []; }
}
