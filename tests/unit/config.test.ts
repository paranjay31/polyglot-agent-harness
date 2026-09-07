import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { loadRepositoryConfig } from "../../packages/config/src/index.js";
describe("repository configuration", () => it("loads validated defaults and repository overrides", async () => { const root = await mkdtemp(join(tmpdir(), "harness-config-")); await mkdir(join(root, ".agent")); await writeFile(join(root, ".agent", "config.json"), JSON.stringify({ model: { provider: "azure-openai", baseUrl: "https://models.example", name: "test", apiKeyEnv: "AZURE_KEY", fallbacks: [{ provider: "ollama", baseUrl: "http://127.0.0.1:11434", name: "local" }] }, repositories: { backend: "../backend" }, sandbox: { kind: "docker", image: "node:20" }, mcp: [{ id: "remote", transport: "http", endpoint: "https://mcp.example", bearerTokenEnv: "MCP_TOKEN" }] })); const config = await loadRepositoryConfig(root); expect(config.permissions.mode).toBe("review"); expect(config.sandbox.kind).toBe("docker"); expect(config.model.fallbacks[0]?.provider).toBe("ollama"); expect(config.repositories.backend).toBe("../backend"); expect(config.mcp[0]?.bearerTokenEnv).toBe("MCP_TOKEN"); }));

it("requires remote worker settings when remote execution is selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-config-")); await mkdir(join(root, ".agent"));
  await writeFile(join(root, ".agent", "config.json"), JSON.stringify({ sandbox: { kind: "remote" } }));
  await expect(loadRepositoryConfig(root)).rejects.toThrow("remote sandbox requires remote endpoint and workspaceId");
  await writeFile(join(root, ".agent", "config.json"), JSON.stringify({ sandbox: { kind: "remote", remote: { endpoint: "https://worker.example", workspaceId: "project-1", bearerTokenEnv: "WORKER_TOKEN" } } }));
  expect((await loadRepositoryConfig(root)).sandbox.remote?.workspaceId).toBe("project-1");
});
