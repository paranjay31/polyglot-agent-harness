# Remote worker deployment

This deployment maps the local `workspace/` directory to the opaque worker workspace ID `my-repository`.

1. Create `deploy/remote-worker/workspace` (or replace that bind mount with the intended absolute host path).
2. Export a long, random `AGENT_REMOTE_WORKER_TOKEN`.
3. From the repository root, run `docker compose -f deploy/remote-worker/compose.yaml up --build`.

The template publishes only to `127.0.0.1:8790`. Put an authenticated TLS reverse proxy in front of it before exposing it beyond the host. Configure the client with `sandbox.kind: "remote"`, endpoint `http://127.0.0.1:8790`, workspace ID `my-repository`, and `bearerTokenEnv` pointing to the same token. The worker stays loopback-only outside containers unless `AGENT_REMOTE_WORKER_HOST` is explicitly set.
