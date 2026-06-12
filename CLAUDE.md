# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **portable, self-contained bundle** for standing up a hardened Linux VPS that exposes Claude Code as an authenticated MCP server. It is mostly documentation + SOP + skills, with one runtime component (`runtime/oauth-proxy.js`). There is no build step, no package manager, no test framework — work here is editing markdown SOPs, skill definitions, and the OAuth proxy.

The repo was extracted from a parent `routines-claude` project and intentionally has zero coupling to it. Anything added here should preserve that portability (no parent-repo paths, no project-specific assumptions).

## Layout and how the pieces relate

```
docs/vps-claude-code-mcp-sop.md   ← the canonical procedure (Phases A–H, decisions D1–D10)
runtime/oauth-proxy.js            ← Node.js MCP 2025-06 OAuth 2.1 AS + protected-resource gateway
skills/<name>/SKILL.md            ← six skills that back specific phases of the SOP
evals/README.md                   ← harness instructions for skill evals (per-skill evals.json)
```

- The SOP in `docs/` is the source of truth. Each phase names the skill that backs it.
- The six skills (`vps-provisioning`, `tunnel-ingress`, `systemd-service-hardening`, `claude-code-headless`, `mcp-bearer-gateway`, `secret-rotation`) are designed to be installed globally into `~/.claude/skills/` — they are not project-local skills.
- `runtime/oauth-proxy.js` is what gets pushed to the VPS in Phase E2. It is the **canonical authenticator** and accepts BOTH a static bearer (CLI/curl path) AND OAuth-issued tokens (claude.ai web/mobile path) on the same `/mcp` endpoint. The `mcp-bearer-gateway` skill covers the static-only subset; keep them consistent.
- Evals live at `skills/<skill>/evals/evals.json` (not all skills have one yet — currently only `vps-provisioning/evals/`).

## Common tasks

There are no build/lint/test commands wired up. The runtime is a single Node file with no dependencies beyond core modules (`http`, `fs`, `crypto`, `url`):

```bash
# Smoke-check the OAuth proxy locally (requires the two env vars below or it exits 1)
MCP_BEARER_TOKEN=$(openssl rand -hex 32) \
OAUTH_LOGIN_PASSWORD=test \
node runtime/oauth-proxy.js
```

Install the skills globally (Windows PowerShell — the environment this repo is edited in):

```powershell
Copy-Item -Recurse skills\* "$env:USERPROFILE\.claude\skills\"
```

Run skill evals (see `evals/README.md` for the full pattern — spawn two subagents per prompt, one with the skill and one without, then aggregate):

```bash
python -m scripts.aggregate_benchmark <workspace>/iteration-1 --skill-name <name>
```

`scripts/` is not in this repo — it lives in `~/.claude/skills/skill-generator/`. Evals are run from there.

## Editing rules specific to this repo

- **Keep the bundle portable.** No paths into a parent repo, no references to other projects. The README's "Portability" section is a hard constraint.
- **SOP placeholders must stay consistent.** `<VPS_IP>`, `<SERVICE_USER>`, `<TS_HOSTNAME>`, `<TS_TAILNET>`, `<PUBLIC_URL>`, `<BEARER_TOKEN>`, `<ANTHROPIC_KEY>` are referenced throughout — don't rename in one place only.
- **The static-bearer path must keep working when OAuth is enabled.** `runtime/oauth-proxy.js` is strictly additive over `mcp-bearer-gateway`; changes that break the CLI/curl path are regressions.
- **OAuth proxy state is persisted JSON at `OAUTH_STATE_PATH`** (default `/home/claude/.config/claude/oauth-state.json`, mode `0600`). Any new fields on `store` (`clients`, `codes`, `pending`, `tokens`, `refresh`) need to survive a reload — the loader does `{ ...defaults, ...loaded }`, so add defaults to the initial `store` literal.
- **The dist tarball does not exist.** Don't introduce a build artifact; the deploy story is "scp the .js file."
- **Git status at session start shows the SOP was reorganized** — `vps-bootstrap/` contents were moved up to the repo root. Treat the top-level `docs/`, `runtime/`, `skills/`, `evals/` as canonical; the `vps-bootstrap/` deletions are intentional.

## Out of scope here

Routines, scheduled agents, per-project skills authoring, and the Softeria MS365 MCP self-hosting addon. The SOP names them but they belong in other repos.
