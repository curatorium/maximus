# Maximus

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through Discord. Each channel gets its own persistent Claude session that can read, write, and operate on your codebase — all running in isolated Docker containers.

## Quick Start

```bash
mkdir maximus && cd maximus
curl -fLO https://github.com/curatorium/maximus/releases/latest/download/docker-compose.yml
curl -fLO https://github.com/curatorium/maximus/releases/latest/download/.env.sample
cp .env.sample .env        # fill in DISCORD_BOT_TOKEN + auth credentials
docker compose up -d
```

## Creating the Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name (e.g. "Maximus").

2. Navigate to **Bot** in the left sidebar:
   - Click **Reset Token** and copy the token — this is your `DISCORD_BOT_TOKEN`
   - Under **Privileged Gateway Intents**, enable:
     - **Message Content Intent** (required — Maximus needs to read message text)
     - **Server Members Intent** (optional)

3. Navigate to **OAuth2** in the left sidebar:
   - Under **Scopes**, select `bot` and `applications.commands`
   - Under **Bot Permissions**, select:
     - Send Messages
     - Send Messages in Threads
     - Read Message History
     - Use Slash Commands
   - Copy the generated URL and open it in your browser to invite the bot to your server

4. Paste the bot token into your `.env` file:
   ```env
   DISCORD_BOT_TOKEN=your-token-here
   ```

## Authentication

Maximus needs credentials to talk to Claude. Choose one method:

| Method | Env Variable | Notes |
|--------|-------------|-------|
| Claude credentials file | Mount `~/.claude/.credentials.json` | Same credentials as your local Claude Code install |
| OAuth token | `CLAUDE_CODE_OAUTH_TOKEN` | Token-based auth |
| API key | `ANTHROPIC_API_KEY` | Direct Anthropic API access |

The auth method is configured per-Artifex instance (see [Provisioning](#provisioning-artifex-instances)).

## Usage

Mention the bot (or use the configured trigger word) in any channel that has a corresponding Artifex instance:

```
@max review the latest PR on this repo and summarize the changes
@max refactor the auth middleware to use JWT instead of sessions
@max why is the CI pipeline failing?
@max write tests for the user registration endpoint
```

Each channel maintains its own Claude session — context carries over between messages. Thread messages are routed to their parent channel's Artifex instance.

## Setup

1. **Create the Discord bot** (see above) and configure `.env`:
   ```env
   AGENT_NAME=@max                  # optional — only respond when mentioned by this name
   OWNER_ID=                        # optional — restrict to a single Discord user ID

   GIT_AUTHOR_NAME=                 # git identity for commits made by Artifex
   GIT_AUTHOR_EMAIL=
   GH_TOKEN=                        # GitHub personal access token for gh CLI

   DISCORD_BOT_TOKEN=your-token     # required
   CLAUDE_CODE_OAUTH_TOKEN=         # choose one auth method
   ```

2. **Start** the Scribe (Discord bot):
   ```bash
   docker compose up -d scribe
   ```

3. **Provision Artifex instances** — one per channel/project (see below).

## Provisioning Artifex Instances

Each Artifex instance maps a Discord channel to a codebase on your host. Provision them via Discord or manually.

### Via Discord Slash Commands

Once Scribe is running, it registers two slash commands:

- **`/provision`** — Generate a `docker-compose.yml` snippet for a single instance:
  - `name` — Service name suffix (e.g. `steward`)
  - `channel` — Discord channel for task routing
  - `credentials` / `claude-oauth-token` / `anthropic-api-key` — Claude auth (at least one required)
  - `gh-credentials` / `gh-token` — GitHub auth *(optional)*
  - `ssh` — Mount SSH key *(optional)*
  - `codebase` *(optional)* — Absolute path to the project directory to mount
  - `mounts` *(optional)* — Comma-separated `host:container[:mode]` volume mounts

- **`/provision-all`** — Generate snippets for all visible text channels at once (same auth options)

Copy the generated YAML into your `docker-compose.override.yml` and run `docker compose up -d`.

### Manually

Create a `docker-compose.override.yml`:

```yaml
services:
  artifex-my-project:
    image: ghcr.io/curatorium/maximus-artifex
    restart: always
    environment:
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: 0
    volumes:
      - artifex-my-project-sessions:/home/artifex/.claude
      - $HOME/.config/gh:/home/artifex/.config/gh:ro
      - $HOME/.claude/.credentials.json:/home/artifex/.claude/.credentials.json:ro
      - $HOME/.maximus/tasks/{channel-id}:/tasks:rw
      - /path/to/your/project:/app

volumes:
  artifex-my-project-sessions: ~
```

Then: `docker compose up -d artifex-my-project`

## Architecture

```
Discord ──► Scribe (Node.js) ──► filesystem ──► Artifex (Claude Code in Docker) ──► filesystem ──► Scribe ──► Discord
```

Two containers. IPC via the filesystem. No daemons, no message queues.

| Component | Role |
|-----------|------|
| **Scribe** | Discord bot that writes incoming messages to `/tasks/{channel}/inbox/` and polls `/tasks/**/outbox/` to send responses back |
| **Artifex** | Headless Claude Code runner (with `--dangerously-skip-permissions`) that processes tasks FIFO, maintains per-channel sessions, and writes responses to the outbox. Runs as non-root inside Docker with only the mounts and env vars you give it. |

### Task Lifecycle

```
inbox/{timestamp}.md  →  working/{timestamp}.md  →  done/{timestamp}.md
                                  ↓
                          outbox/{timestamp}.md  →  sent/{timestamp}.md
```

1. **Scribe** writes the message to `inbox/`
2. **Artifex** claims it by moving to `working/`, pipes it into `claude --print`
3. Claude's response goes to `outbox/`, the task moves to `done/`
4. **Scribe** sends the outbox file to Discord and moves it to `sent/`

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `AGENT_NAME` | No | Only respond when this name is mentioned (e.g. `@max`) |
| `OWNER_ID` | No | Only accept messages from this Discord user ID |
| `GIT_AUTHOR_NAME` | No | Git author name for commits made by Artifex |
| `GIT_AUTHOR_EMAIL` | No | Git author email for commits made by Artifex |
| `GH_TOKEN` | No | GitHub personal access token for `gh` CLI inside Artifex |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (one of three auth methods) |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | Claude Code OAuth token (one of three auth methods) |
| `ARTIFEX_PROMPT` | No | Additional system prompt appended to Claude sessions |
| `POLL_INTERVAL` | No | Outbox polling interval in ms (default: `100`) |

## Project Structure

```
maximus/
├── artifex/
│   ├── Dockerfile        # Claude Code container image
│   ├── entrypoint        # Task loop: picks inbox files, runs Claude, writes outbox
│   └── Stewardfile       # System dependencies (claude-code, gh, git, jq, etc.)
├── scribe/
│   ├── Dockerfile        # Discord bot container image
│   ├── Stewardfile       # System dependencies
│   ├── index.js          # Discord bot: listens, writes tasks, polls outbox, sends replies
│   ├── provision.yml.hbs # Handlebars template for generating Artifex compose snippets
│   └── package.json
├── docker-compose.yml          # Base service definitions
├── docker-compose.override.yml # Your local Artifex instances (gitignored)
├── .env.sample                 # Environment variable template
└── .env                        # Your local config (gitignored)
```

## FAQ

**Why Discord and not Slack/Telegram/WhatsApp?**

Because I use Discord. The Scribe is ~300 lines of code — swap it for your preferred platform.

**Is this secure?**

Claude Code runs with `--dangerously-skip-permissions` — but inside a Docker container, as a non-root user, with only the volumes and environment variables you explicitly mount. The container *is* the sandbox. You control exactly what each Artifex instance can access.

**Why a file-based task queue instead of Redis/RabbitMQ/etc.?**

Simplicity. Files are debuggable (`ls /tasks/*/inbox`), require no additional services, and survive restarts. The entire IPC mechanism is `fs.writeFileSync` and `mv`.

**Can multiple people use the same bot?**

Yes. Leave `OWNER_ID` empty and anyone in the Discord server can talk to it. Set `OWNER_ID` to restrict it to a single user.

**How do I give an Artifex instance access to GitHub?**

Set `GH_TOKEN` in your `.env` to a [GitHub personal access token](https://github.com/settings/tokens). This is passed to Artifex containers as an environment variable and authenticates the `gh` CLI automatically.

**How do I debug a stuck task?**

Check the task directories on your host:
```bash
ls ~/.maximus/tasks/*/inbox/    # pending tasks
ls ~/.maximus/tasks/*/working/  # currently processing
ls ~/.maximus/tasks/*/outbox/   # waiting to be sent
```

## License

[MIT](LICENSE) — Mihai Stancu
