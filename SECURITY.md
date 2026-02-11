# Security

Maximus is a developer tool that runs Claude Code inside Docker containers, controlled via Discord. It assumes the operator is a developer who understands Docker and intentionally chooses what to expose.

## Security Model

**The container is the sandbox.** Claude Code runs with `--dangerously-skip-permissions` — but only inside a Docker container, as a non-root user, with only the volumes and environment variables the operator explicitly mounts. The agent has zero ability to influence its own access scope.

This is a static access control model: the operator defines the sandbox boundary in `docker-compose.override.yml`, and the agent operates freely within it. There is no allowlist to bypass, no mount-request mechanism to exploit, and no validation layer that could contain bugs — because there is no request mechanism at all.

## Trust Model

| Actor | Trust Level | Rationale |
|-------|-------------|-----------|
| **Operator** | Fully trusted | Defines all mounts, env vars, and container configuration |
| **Discord users** | Controlled | Filtered by `OWNER_ID` (single user) and/or `AGENT_NAME` (mention-gated). Bot messages and system events are ignored |
| **Claude agent** | Sandboxed | Full autonomy inside the container; zero influence over its own access scope |
| **Discord messages** | Untrusted input | Potential prompt injection vector — the agent processes raw message text |

## Container Isolation

Each Artifex instance runs as an independent Docker container with:

- **Non-root execution** — the `artifex` user has no host privileges
- **Explicit volume mounts** — only directories the operator mounts are visible inside the container
- **Read-only mounts where possible** — credentials, SSH keys, and GitHub config are mounted `:ro`
- **Resource limits** — CPU, memory, and PID caps are defined in the base service (see `docker-compose.yml`)
- **Ephemeral filesystem** — the container's root filesystem is not persisted; only named volumes survive restarts
- **Session volumes** — Claude session state is stored in named Docker volumes, isolated per instance

### What is NOT isolated

- **Network** — containers have default Docker networking (internet access, inter-container communication). Consider adding `network_mode: none` for instances that don't need network, or defining isolated Docker networks
- **Kernel** — Docker containers share the host kernel. A kernel exploit could escape the sandbox. For stronger isolation, run Docker inside a VM or use a microVM runtime (Kata Containers, Firecracker)
- **Docker socket** — some instances mount `/var/run/docker.sock` for Docker-in-Docker operations. The socket itself grants full Docker API access, but the agent runs as non-root and cannot use Docker directly. Access is gated through `sudoers-*` files that whitelist specific commands — e.g. only `docker compose up/down` for a specific project, or only `docker run --rm` with a pinned image and volume. Only mount the socket on instances that need it, and always pair it with a scoped sudoers file

## Access Control

The operator controls access at two levels:

### Who can talk to the bot

| Mechanism | Configuration | Default |
|-----------|--------------|---------|
| `OWNER_ID` | Restricts to a single Discord user ID | Empty (all users accepted) |
| `AGENT_NAME` | Bot only responds when mentioned or named in the message | Empty (responds to all messages) |
| Bot filter | `message.author.bot` is rejected | Always on |
| Message type filter | Only `Default` and `Reply` types are processed | Always on |

### What the agent can access

Entirely determined by `docker-compose.override.yml`. There is no in-application permission system — Docker enforces the boundary at the OS level. The operator decides per instance:

- **Volumes** — the agent can only see files in explicitly mounted paths
- **Environment variables** — only variables defined in `environment:` or `env_file:` are available
- **Credentials** — the operator chooses which auth method and credentials to expose per instance
- **Codebase** — each instance mounts a specific project directory (or none)
- **Docker socket** — only mounted on instances that need it, always paired with a scoped `sudoers-*` file
- **Read-only access** — mounts can be `:ro` to give the agent visibility without write access (e.g. credentials, other instances' session logs)

In practice this creates tiers of access. For example:

| Tier | Capabilities | Example |
|------|-------------|---------|
| Code-only | Read/write a single project, credentials | Most instances |
| Docker-capable | Code-only + scoped Docker commands via sudoers | Instances that build/deploy |
| Observer | Read-only access to other instances' sessions | Architecture/oversight instance |

## Credential Handling

| Credential | Storage | Exposure |
|------------|---------|----------|
| `DISCORD_BOT_TOKEN` | `.env` file (gitignored) | Scribe only — never passed to Artifex |
| `ANTHROPIC_API_KEY` | `.env` file (gitignored) | Passed as env var to Artifex instances that need it |
| `CLAUDE_CODE_OAUTH_TOKEN` | `.env` file (gitignored) | Passed as env var to Artifex instances that need it |
| `GH_TOKEN` | `.env` file (gitignored) | Passed as env var to Artifex instances that need it |
| Claude credentials file | `~/.claude/.credentials.json` | Mounted read-only into Artifex instances that need it |
| GitHub credentials | `~/.config/gh/` | Mounted read-only into Artifex instances that need it |
| SSH keys | `~/.maximus/ssh/` | Mounted read-only into Artifex instances that need it |

**Known limitation:** API keys and tokens passed as environment variables are readable by the agent inside the container (via `/proc/self/environ` or `env`). This is inherent to the design — the agent needs these credentials to function. A compromised agent could exfiltrate them if it has network access.

**Mitigation:** Use short-lived or scoped tokens where possible. The Claude credentials file (OAuth) is preferable to a raw API key because it can be revoked.

## IPC Security

Scribe and Artifex communicate exclusively via the filesystem:

- **No network sockets, no message queues, no shared memory** — IPC is `fs.writeFileSync` and `mv`
- **Task files are plaintext Markdown** — stored at `~/.maximus/tasks/` on the host
- **Task lifecycle is atomic** — `mv` is atomic on the same filesystem, preventing partial reads
- **Task history accumulates** — completed tasks remain in `done/` (user requests) and `sent/` (agent responses) directories as plaintext. Anyone with host filesystem access can read them

## Resource Limits

Base resource limits are defined in `docker-compose.yml` and inherited by provisioned instances:

| Resource | Artifex | Scribe |
|----------|---------|--------|
| CPU | 2 cores | 1 core |
| Memory | 6 GB | 512 MB |
| PIDs | 256 | 128 |

These prevent a runaway agent from exhausting host resources (fork bombs, memory leaks, CPU spin). Override per-instance in `docker-compose.override.yml` if needed.

## Hardening Checklist

For production or sensitive deployments, consider:

- [ ] Set `OWNER_ID` to restrict bot access to yourself
- [ ] Set `AGENT_NAME` to require explicit mentions
- [ ] Use read-only mounts (`:ro`) for everything except the task queue and working directory
- [ ] Avoid mounting `docker.sock` unless the instance specifically needs Docker operations — and always pair it with a `sudoers-*` file that whitelists only the exact commands needed
- [ ] Use scoped GitHub tokens with minimal repository permissions
- [ ] Add `network_mode: "none"` or use isolated Docker networks to restrict network access per instance
- [ ] Review `done/` and `sent/` task directories periodically and clean up sensitive content
- [ ] Run Docker inside a VM for kernel-level isolation

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/curatorium/maximus/security/advisories/new). Do not file public issues for security vulnerabilities.
