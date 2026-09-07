#!/usr/bin/env node
import { RemoteWorker, createRemoteWorkerServer } from "../../../packages/sandbox/src/index.js";

function main() {
  const roots = JSON.parse(process.env.AGENT_REMOTE_WORKSPACES ?? "{}") as Record<string, string>;
  const key = process.env.AGENT_REMOTE_WORKER_TOKEN ?? "";
  const port = Number(process.env.PORT ?? 8790);
  const host = process.env.AGENT_REMOTE_WORKER_HOST ?? "127.0.0.1";
  createRemoteWorkerServer(new RemoteWorker(roots), key).listen(port, host, () => process.stdout.write(`Remote worker listening on http://${host}:${port}\n`));
}
if (process.argv[1]?.endsWith("apps/remote-worker/src/main.ts") || process.argv[1]?.endsWith("apps/remote-worker/src/main.js")) main();
