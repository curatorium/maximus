# Maximus

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through Discord. Each channel gets its own persistent Claude session that can read, write, and operate on your codebase — all running in isolated Docker containers you control.

## Quick Start

```bash
# Install the CLI
sudo curl -fL https://github.com/curatorium/maximus/releases/latest/download/maximus -o /usr/local/bin/maximus
sudo chmod +x /usr/local/bin/maximus

# Add an Artifex instance — run from inside your project directory
cd ~/Projects/my-project
maximus start my-channel
```

## Creating the Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name (e.g. "Maximus").

2. Navigate to **Bot** in the left sidebar:
   - Click **Reset Token** and copy the token — this is your `DISCORD_BOT_TOKEN`
   - Under **Privileged Gateway Intents**, enable:
     - **Message Content Intent** (required — Maximus needs to read message text)
     - **Server Members Intent** (optional)

3. Navigate to **OAuth2** in the left sidebar:
   - Under **Scopes**, select `bot`
   - Under **Bot Permissions**, select:
     - Send Messages
     - Send Messages in Threads
     - Read Message History
   - Copy the generated URL and open it in your browser to invite the bot to your server

4. Run `maximus install` and paste the token when prompted.

## CLI Reference

```
maximus install              Set up the Scribe (Discord bot) service
maximus add     <channel>    Create a new Artifex config for a Discord channel
maximus start   [channel]    Start all services or a specific channel
maximus env     [channel]    Edit shared .env or instance-specific <channel>.env (restarts)
maximus mounts  [channel]    Edit shared or instance volume mounts (restarts)
maximus sudoers <channel>    Edit sudoers for an instance via visudo (restarts)
maximus attach  <channel>    Exec into the container and resume the last Claude session

maximus up      [channel]    Create and start container(s)
maximus ps      [channel]    Show running container(s)
maximus logs    [channel]    Show container log(s) (-f to follow)
maximus down    [channel]    Stop and remove container(s)
```

Any command not listed above is passed through to `docker compose`.

### Adding an Artifex Instance

Run `maximus add <channel>` from inside your project directory. The channel name maps to a Discord channel:

```bash
cd ~/Projects/my-project
maximus add my-channel
```

The project's `.git` directory is mounted as `/app.git`. Artifex creates worktrees from it inside `/app` — this isolates the container's working directory from yours.

### Environment Variables and Mounts

Use `maximus env` and `maximus mounts` to configure instances. Without a channel name, edits the shared config (applies to all instances). With a channel name, edits instance-specific config. Both restart services after saving.

```bash
maximus env                 # shared env vars
maximus env my-channel      # instance-specific env vars
maximus mounts              # shared volume mounts
maximus mounts my-channel   # instance-specific volume mounts
```

Mounts are one per line in Docker volume format (e.g. `~/src:/app:ro`).

### Privileged Access (sudoers)

```bash
maximus sudoers my-channel
```

Uses `visudo` for syntax checking. When the sudoers file exists, it's automatically mounted into the container.

## Authentication

Maximus needs credentials to talk to Claude. By default it mounts `~/.claude`. Alternatively, set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` via `maximus env`.

## Usage

Mention the bot (or use the configured `AGENT_NAME`) in any channel that has a corresponding Artifex instance:

```
@max review the latest PR on this repo and summarize the changes
@max refactor the auth middleware to use JWT instead of sessions
@max why is the CI pipeline failing?
@max write tests for the user registration endpoint
```

Each channel maintains its own Claude session — context carries over between messages.

## Architecture

```
Discord --> Scribe (Node.js) --> filesystem --> Artifex (Claude Code) --> filesystem --> Scribe --> Discord
```

One Artifex per channel (plus one global Scribe). IPC via the filesystem. No daemons, no message queues.

| Component | Role |
|-----------|------|
| **Scribe** | Discord bot that writes incoming messages to `/tasks/discord/{channel}/inbox/` and polls `/tasks/**/outbox/` to send replies back |
| **Artifex** | Headless Claude Code runner (`--dangerously-skip-permissions`) that processes tasks FIFO, maintains per-channel sessions, and writes responses to the outbox. Runs as non-root inside Docker with only the mounts and env vars you give it. |

### Task Lifecycle

```
inbox/{timestamp}.md  -->  working/{timestamp}.md  -->  done/{timestamp}.md
                                    |
                            outbox/{timestamp}.md  -->  sent/{timestamp}.md
```

1. **Scribe** writes the message to `inbox/`
2. **Artifex** claims it by moving to `working/`, pipes it into `claude --print`
3. Claude's response goes to `outbox/`, the task moves to `done/`
4. **Scribe** sends the outbox file to Discord and moves it to `sent/`

### File Layout

```
~/.maximus/
  tasks/discord/<channel>/      # Task directories (inbox, working, outbox, done, sent)
```

## Configuration

### Scribe

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `AGENT_NAME` | No | Only respond when this name is mentioned (e.g. `@max`) |
| `OWNER_ID` | No | Only accept messages from this Discord user ID |

### Artifex (via `maximus env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No | Anthropic API key (alternative auth method) |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | Claude Code OAuth token (alternative auth method) |
| `ARTIFEX_PROMPT` | No | Override the default system prompt for Claude sessions |
| `ARTIFEX_NUDGE` | No | Override the instruction prepended to each task |

## FAQ

**Why Discord and not Slack/Telegram/WhatsApp?**

Because I use Discord. The Scribe is ~200 lines of code — swap it for your preferred platform.

**Is this secure?**

Claude Code runs with `--dangerously-skip-permissions` — but inside a Docker container, as a non-root user, with only the volumes and environment variables you explicitly mount. The container *is* the sandbox. You control exactly what each Artifex instance can access.

**Why a file-based task queue instead of Redis/RabbitMQ/etc.?**

Simplicity. Files are debuggable (`ls ~/.maximus/tasks/discord/*/inbox`), require no additional services, and survive restarts. The entire IPC mechanism is `fs.writeFileSync` and `mv`.

**Can multiple people use the same bot?**

Yes. Leave `OWNER_ID` empty and anyone in the Discord server can talk to it. Set `OWNER_ID` to restrict it to a single user.

**How do I debug a stuck task?**

Check the task directories on your host:
```bash
ls ~/.maximus/tasks/discord/*/inbox/    # pending tasks
ls ~/.maximus/tasks/discord/*/working/  # currently processing
ls ~/.maximus/tasks/discord/*/outbox/   # waiting to be sent
```

## License

[MIT](LICENSE) — Mihai Stancu
