import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigSchema } from "../../packages/config/src/index.js";
import { inspectReadiness } from "../../packages/diagnostics/src/index.js";

describe("readiness diagnostics", () => it("reports model configuration, verification commands, and local sandbox readiness without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-doctor-")); await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  const report = await inspectReadiness(root, AgentConfigSchema.parse({}), {});
  expect(report.ready).toBe(false); expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "model", status: "fail" }), expect.objectContaining({ name: "verification", status: "pass", detail: "npm test" }), expect.objectContaining({ name: "sandbox", status: "pass", detail: "local" })]));
}));

it("confirms configured remote/model prerequisites without serializing their credentials", async () => { const root = await mkdtemp(join(tmpdir(), "harness-doctor-secret-")); const secret = "this-is-not-a-reportable-secret"; const config = AgentConfigSchema.parse({ model: { provider: "openai-compatible", baseUrl: "https://models.example/v1", name: "coding-model", apiKeyEnv: "MODEL_SECRET" }, sandbox: { kind: "remote", remote: { endpoint: "https://worker.example", workspaceId: "private-project", bearerTokenEnv: "WORKER_SECRET" } } }); const report = await inspectReadiness(root, config, { MODEL_SECRET: secret, WORKER_SECRET: secret }); expect(report.ready).toBe(true); expect(JSON.stringify(report)).not.toContain(secret); expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "model", status: "pass" }), expect.objectContaining({ name: "sandbox", status: "pass", detail: "remote workspace private-project" })])); });
