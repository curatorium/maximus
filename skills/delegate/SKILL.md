---
name: delegate
description: Delegate a task to an artifex (a maximus builder channel) and wait asynchronously for the reply. Use when the user wants a specific artifex to do work while the coordinator keeps going with other items on the task list.
---

# Delegate Skill

Send a task to an **artifex** (a maximus builder channel) via `maximus send <channel>`, run it in the background, and surface the reply when the artifex finishes. The coordinator stays free to triage, plan, or delegate more work while the artifex is busy.

## When to use

- The user has a task list and wants to dispatch specific items to specific artifexes.
- The task is well-scoped enough that the artifex can run it without follow-up questions (replies are one-shot by design — the artifex cannot ask you anything back mid-flight).
- The user wants to be notified when the artifex is done, not kept in the loop for every tool call.

## When not to use

- The task needs interactive clarification from you. Do it directly instead.
- Multiple artifexes need to coordinate. Delegate each piece separately; a swarm coordinator is out of scope here.

## Command shape

```
echo "<task body>" | maximus send <channel>
```

- Stdin is the full task prompt.
- Blocks until the artifex finishes, then prints the reply to stdout.
- Exits nonzero if the channel is unknown or no reply appears.

## Background execution

Run with `Bash(run_in_background=true)` so the coordinator stays responsive. The command has no intermediate output by design — stdout is empty until the artifex is done, then the full reply arrives at once.

Example:

```
Bash(command='echo "refactor the auth module to use JWT" | maximus send auth-refactor',
     run_in_background=true,
     description='Delegate auth refactor to auth-refactor artifex')
```

After firing the background send, **schedule a recurring 1-minute check** so the coordinator doesn't forget about the delegation. Use whatever scheduling primitive is available (`ScheduleWakeup`, a cron trigger, the `loop` skill — whatever the coordinator has). The check calls `BashOutput` on the shell ID and does one of:

- Still running → re-arm the 1-minute check and continue with other work.
- Exited → read stdout (the artifex's reply), cancel the schedule, surface to the user.

"At the latest once every minute" is the contract — the coordinator can check sooner if it's already between tasks, but it must not go longer than 60 seconds without polling. A delegation left unpolled is a delegation the user doesn't know completed.

If several delegations are in flight, one recurring check can sweep all of them — keep a mapping of shell IDs to artifex names so each completion can be surfaced with its context.

## Notifying the user

When the backgrounded send exits:

1. Read its stdout — that is the artifex's final reply.
2. Surface it to the user with a one-line framing: which artifex, what task, what it reported.
3. Do not re-run the task. If the reply indicates incomplete work, ask the user before delegating a follow-up.

## Channel requirement

`maximus send` is for channels that do **not** exist on Discord — headless channels created via `maximus add <name>` where `<name>` does not match a Discord channel in the bot's guild. Think of it as a terminal-based chat client, not a second consumer running alongside Discord.

Do not use `maximus send` on a Discord-bound channel. The reply will go to Discord (Scribe posts it, moves the file to `sent/`) and `send` will fail to find it. If you want to talk to an artifex via Discord, use Discord; if you want to talk from the coordinator, set up a headless artifex.

## Spawning a new artifex

If no suitable artifex exists, create one. It's a headless channel by default (just pick a name the Discord guild doesn't use).

```bash
cd /path/to/project          # maximus add captures $PWD
maximus add <name>           # creates ~/.maximus/<name>.conf, tasks dir, session dir
maximus up -d <name>         # start the container
echo "<task>" | maximus send <name>
```

Naming:

- Short, lowercase, hyphens only (becomes a compose service and filesystem path).
- Must not match any Discord channel in the bot's guild — otherwise it becomes Scribe-bound and `maximus send` will fail.
- Must not match an existing maximus channel — `maximus add` silently overwrites `.conf`.
- Suggested prefixes: `build-`, `hl-`, or `task-` to make the headless intent obvious (`build-auth-refactor`, `hl-readme-sync`).

### `--worktree` mode

When the user asks for `--worktree` (or says "in a worktree", "isolate this", "don't touch my working copy"), bind the artifex to a fresh git worktree instead of the main project. This lets the artifex experiment, refactor, or make large mechanical changes without affecting the user's current checkout.

```bash
slug="<short-name-for-this-task>"
git worktree add ../$(basename "$PWD")-$slug -b $slug
cd ../$(basename "$PWD")-$slug
maximus add build-$slug
maximus up -d build-$slug
echo "<task>" | maximus send build-$slug
```

Important constraints:

- The `cd` into the worktree before `maximus add` is load-bearing. `maximus add` captures `$PWD` as the artifex's project root; the artifex's `/app` will be bound to the worktree, not the main checkout.
- Do **not** auto-clean the worktree when the artifex finishes. The user will want to review the diff, merge it, or discard it. Ask before tearing anything down.
- If the user approves cleanup:

  ```bash
  maximus down build-$slug
  rm -f ~/.maximus/build-$slug.conf ~/.maximus/build-$slug.env ~/.maximus/build-$slug.mounts ~/.maximus/build-$slug.prompt
  git worktree remove ../$(basename "$PWD")-$slug
  git branch -D $slug   # only if the branch work is discarded
  ```

## Invocation patterns from the user

- "delegate X to <channel>" → use the existing channel.
- "delegate X to a new artifex" or "spawn an artifex for X" → set up a new headless artifex first.
- "delegate X to a new artifex --worktree" or "isolate this in a worktree" → set up a new headless artifex bound to a fresh git worktree.
- The user rarely names the artifex themselves. Pick a short, descriptive slug from the task text and tell them what you chose.

## Failure modes

- **Channel does not exist**: command fails immediately. Ask the user which channel to use or offer to `maximus add <channel>`.
- **Container not running**: the task sits in `inbox/` and `maximus send` blocks indefinitely. Suggest `maximus up -d <channel>` to the user rather than engineering around it.
- **Channel is Discord-bound**: the reply goes to Discord, not stdout. `cat` fails, `send` exits nonzero. Move the task to a headless channel instead.
- **Ctrl-C on the coordinator side**: the inbox file remains; the artifex will still pick it up and process it. The reply ends up in `outbox/` but nothing is watching. Either re-run `maximus send` with the same body (generates a new task) or read the file directly.

## What this skill does not do

- It does not parse the user's task list or decide what to delegate. That's your job as coordinator.
- It does not manage multiple concurrent delegations. If you fire several, track the shell IDs yourself.
- It does not ask the artifex follow-up questions mid-flight. The artifex's single reply is the terminal signal.
