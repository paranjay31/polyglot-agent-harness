# Remote worker deployment

Every command runs in a separate Docker or Podman container. Only the assigned workspace is mounted. Command containers have no network, a read-only root filesystem, dropped capabilities, and CPU, memory, and process limits. The worker's authentication token and Docker socket are not passed into command containers.

For a host process, install Docker or Podman, prepare an image containing the project's tools, and set `AGENT_REMOTE_WORKSPACES`, `AGENT_REMOTE_WORKER_TOKEN`, and optionally `AGENT_REMOTE_RUNTIME=docker|podman` and `AGENT_REMOTE_IMAGE`. Run `pnpm remote-worker`. Local, unconfined command execution is no longer supported. File reads and writes still use the worker's confined file boundary.

For Docker Compose:

1. Set `AGENT_REMOTE_WORKSPACE_PATH` to the canonical absolute path of the repository on the Docker daemon host. The worker and daemon must see the same path.
2. Export a long, random `AGENT_REMOTE_WORKER_TOKEN` and optionally `AGENT_REMOTE_IMAGE` (default `node:20-bookworm-slim`). Pre-pull the image for offline use.
3. Run `docker compose -f deploy/remote-worker/compose.yaml up --build` from the repository root.

The Compose worker is a trusted control-plane process with access to the Docker socket. Protect its token and host access accordingly. That socket is never mounted in the containers executing repository commands. This template expects a local Unix Docker socket; for a remote daemon, deploy the worker on the daemon host.

The template publishes only to `127.0.0.1:8790`. Use an authenticated TLS reverse proxy before exposing it beyond the host. Configure the client with `sandbox.kind: "remote"`, endpoint `http://127.0.0.1:8790`, workspace ID `my-repository`, and `bearerTokenEnv` pointing to the token. Pin the reviewed client configuration using `AGENT_TRUSTED_CONFIG_SHA256` as described in the main README.

Remote cancellation uses an operation ID and an authenticated cancellation request. The client waits for the worker to acknowledge execution termination. If the worker is unreachable, cancellation cannot be confirmed; inspect the worker before assuming the command has stopped.
