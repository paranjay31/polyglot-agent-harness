# Release readiness runbook

Run these steps from the repository root after configuring the required external services. Do not add API keys or worker tokens to repository files.

## 1. Configure and validate a model

Set these only in the release shell or CI secret store:

```bash
export AGENT_MODEL_BASE_URL=https://your-model-endpoint/v1
export AGENT_MODEL_API_KEY=your-secret
export AGENT_MODEL=your-tool-capable-model
```

Then require a clean doctor report and run the opt-in end-to-end fixture:

```bash
pnpm agent -- doctor --workspace . --json
AGENT_REAL_PROVIDER_E2E=1 pnpm test -- tests/integration/real-provider-e2e.test.ts
```

The fixture uses a temporary repository and a read-only tool policy. Retain its CI output with the release evidence.

## 2. Validate the container sandbox

Start Docker Desktop (or make Podman available), then check the daemon before running the container-focused suite:

```bash
docker version
pnpm test -- tests/unit/container-sandbox.test.ts
```

For a real remote-worker validation, export a long random `AGENT_REMOTE_WORKER_TOKEN`, create `deploy/remote-worker/workspace`, and start the loopback-only Compose template:

```bash
docker compose -f deploy/remote-worker/compose.yaml up --build
```

Configure the client with `sandbox.kind: "remote"`, the mapped `workspaceId`, and the same token’s environment-variable name. Keep the worker behind loopback or an authenticated TLS proxy.

## 3. Verify and publish the package

```bash
pnpm build
pnpm test
pnpm pack
```

Before triggering `.github/workflows/release.yml`, configure the npm trusted publisher for that exact workflow and set the package `repository.url` to its exact public GitHub URL. The release workflow uses Node 24 so npm trusted publishing can issue provenance.

## Released baseline

The public `v0.1.1` release was published through the configured GitHub Actions trusted publisher with a signed provenance statement. For future releases, bump the package version, run the checks above, commit the change, and push a matching `v*` Git tag to trigger the same workflow.
