#!/usr/bin/env node
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createAcpDispatcher } from "./index.js";
import { createConfiguredRunHandler } from "../../server/src/main.js";

async function main() {
  const workspace = resolve(process.env.AGENT_ACP_WORKSPACE ?? process.cwd()); const dispatch = createAcpDispatcher({ workspace, handler: await createConfiguredRunHandler(workspace), notify: async (method, params) => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); } });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) { if (!line.trim()) continue; try { const response = await dispatch(JSON.parse(line)); if (response) process.stdout.write(JSON.stringify(response) + "\n"); } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof Error ? error.message : "Parse error" } }) + "\n"); } }
}
if (process.argv[1]?.endsWith("apps/acp/src/main.ts") || process.argv[1]?.endsWith("apps/acp/src/main.js")) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
