---
name: claude-code-headless
description: Run Claude Code non-interactively on a Linux server under a non-root service user — install via npm, authenticate via API key vs `claude login`, load env vars under systemd, and invoke via `claude --print` or `claude mcp serve`. Use this skill whenever the user mentions running Claude Code on a server, VPS, in CI/CD, in a cron job, in Docker, "headless Claude", "Claude on a remote machine", scheduled agents that need Claude, or wants to expose Claude Code's tools to another process. Prefer this skill over generic npm-install advice anytime Claude Code itself is the workload.
---

# claude-code-headless

How to install and run Claude Code reliably on a Linux server with no human at the keyboard. Covers auth, env loading, and the two invocation modes that actually work in automation.

## When this applies

- Claude Code itself is what you're running on a server (not just a target for Claude to edit)
- No interactive terminal — cron, systemd, CI, container, or scheduled job
- You need predictable behaviour across reboots and rotations

## Why headless is different from your laptop

On your laptop `claude` reads the TTY, prompts for auth on first run, and stores a refreshable token under `~/.config`. On a server none of that is reliable: no TTY for the prompt, no browser to complete OAuth, and the token cache may be wiped on container rebuilds. The two patterns below pick the right tradeoff per use case.

## Install

As root, system-wide so any user can invoke:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt -y install nodejs
npm install -g @anthropic-ai/claude-code
claude --version
```

Then create the non-root service user (see `vps-provisioning`) and switch to it:

```bash
su - <service_user>
```

## Auth — pick one path, write it down

### Path A — API key (recommended for headless)

Stable, scriptable, never expires until you rotate it. No browser ever needed.

```bash
mkdir -p ~/.config/claude
cat > ~/.config/claude/.env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
EOF
chmod 600 ~/.config/claude/.env
```

Consumes from your Anthropic API credit balance.

### Path B — `claude login` (subscription)

Use only when you specifically want the service tied to a Claude.ai Pro/Max subscription instead of API metering.

```bash
claude login
# device-code flow — you need to open the URL on your laptop, paste the code
```

Caveats:
- Survives reboots (token stored under `~/.config/claude/`)
- Token can expire / require re-login after long idle periods
- Container rebuilds wipe it unless you mount the config dir as a volume
- Not viable in fully air-gapped environments (the device-code URL requires browser interaction)

**Decision rule**: API key for anything fully unattended. `claude login` only when the subscription pricing materially matters and someone can re-auth occasionally.

## Smoke test

```bash
echo "Say hello in five words." | claude --print
```

Five-word response = healthy. Anything else, check `journalctl --user -u <unit>` or stderr.

## Invocation modes that work headless

### `claude --print` — single-shot

```bash
claude --print "Summarise this file: $(cat report.txt)"
```

- Reads prompt from arg or stdin, writes answer to stdout
- Exits cleanly — ideal for cron and pipelines
- Returns non-zero on auth or API failure (check `$?`)

### `claude mcp serve` — long-running MCP server

```bash
claude mcp serve
```

- Exposes Claude Code's tools (Read, Edit, Bash, etc.) over MCP stdio transport
- Other processes (or remote clients via a bridge) consume it
- Bridge it to authenticated HTTP for remote access — see `mcp-bearer-gateway`

### Interactive REPL — not for headless

`claude` with no args opens the interactive UI. Don't use this in scripts; it will hang waiting for stdin.

## Under systemd

The non-obvious part is env-var loading. Claude Code reads `ANTHROPIC_API_KEY` from the process environment, not from `~/.config/claude/.env` automatically. Two ways:

**Option 1 — `EnvironmentFile=` (preferred)**

The `.env` file must use plain `KEY=value`, no `export`, no shell quoting:

```
ANTHROPIC_API_KEY=sk-ant-...
```

In the unit:

```ini
EnvironmentFile=/home/<service_user>/.config/claude/.env
```

**Option 2 — explicit `Environment=` lines**

```ini
Environment=ANTHROPIC_API_KEY=sk-ant-...
```

Avoid this — the unit file is world-readable; the key leaks.

See `systemd-service-hardening` for the full unit template.

## Working directory matters

Claude Code's tools operate relative to `WorkingDirectory=`. For an MCP server, point this at a stable workspace dir, not `/tmp`:

```ini
WorkingDirectory=/home/<service_user>/workspace/mcp-host
```

Files Claude writes go here. Combined with `ProtectHome=read-only` + `ReadWritePaths=` (see hardening skill), this confines Claude to one tree.

## Cron pattern

```cron
0 14 * * 1-5 /usr/bin/claude --print "Daily summary task: ..." >> /home/<service_user>/logs/daily.log 2>&1
```

But really — prefer a systemd timer over cron, because it inherits the unit's `EnvironmentFile` and sandbox automatically.

## Verification checklist

- [ ] `claude --version` works as `<service_user>`, not just root
- [ ] `echo hi | claude --print` returns text without prompting
- [ ] `ls -la ~/.config/claude/.env` is `600`, owned by `<service_user>`
- [ ] When invoked via systemd, `journalctl -u <name>` shows the API key was picked up (no "no API key" error)
- [ ] Claude can only read/write inside `WorkingDirectory` + `ReadWritePaths`

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Error: No API key found` under systemd | `.env` not loaded or wrong format | Confirm `EnvironmentFile=`; check no `export` / quotes in the file |
| `claude` hangs forever in cron | Invoked interactive REPL by accident | Always use `--print` for non-interactive |
| Token cache wiped after container rebuild | `~/.config/claude/` not persisted | Mount the dir as a volume, or switch to Path A (API key) |
| `command not found: claude` in cron | Cron PATH minimal | Use absolute path `/usr/bin/claude` |
| Permission denied writing files | Sandbox `ReadWritePaths=` doesn't cover the dir | Extend `ReadWritePaths=` |

## Out of scope

- Authoring skills and routines that run inside Claude — separate skills
- Wrapping `claude mcp serve` for remote HTTP access — see `mcp-bearer-gateway`
- Tunnel choice — see `tunnel-ingress`
