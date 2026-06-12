# vps-bootstrap

Portable bundle for standing up a professional VPS with Claude Code exposed as an MCP server.

This directory is **self-contained** — copy it into any repo (or keep it standalone) and it brings everything needed: the SOP, the new skills authored for it, and a manifest of which existing skills to install globally first.

## Contents

```
vps-bootstrap/
├── README.md                         ← you are here
├── docs/
│   └── vps-claude-code-mcp-sop.md    ← the procedure (Phases A–H)
├── runtime/
│   └── oauth-proxy.js                ← MCP-spec OAuth 2.1 + static-bearer gateway
│                                        (pushed to the VPS in Phase E2)
└── skills/
    ├── vps-provisioning/SKILL.md
    ├── tunnel-ingress/SKILL.md
    ├── systemd-service-hardening/SKILL.md
    ├── claude-code-headless/SKILL.md
    ├── mcp-bearer-gateway/SKILL.md   ← static bearer only (CLI-only deploys)
    └── secret-rotation/SKILL.md
```

`runtime/oauth-proxy.js` is the canonical authenticator. It accepts **both** a static bearer token (for `claude mcp add ... --header`, curl, custom agents) **and** OAuth-issued access tokens (for claude.ai web/mobile, which won't accept a static bearer). One endpoint, one process, dual-mode.

## Install (global, once per machine)

The six new skills can be installed globally so any project can use them:

```bash
# Linux / macOS
cp -r skills/* ~/.claude/skills/

# Windows (PowerShell)
Copy-Item -Recurse skills\* "$env:USERPROFILE\.claude\skills\"
```

After install, invoke any of them via the `Skill` tool by name (e.g. `vps-provisioning`).

## Prerequisite existing skills

These are not in this bundle. Install or confirm them in `~/.claude/skills/` before running the SOP:

- `mcp-server-patterns`
- `deployment-patterns`
- `terminal-ops`

Optional, situational:

- `docker-patterns` — containerised Phase E
- `api-connector-builder` — non-Claude MCP clients
- `github-ops` — workspace + deploy-key management
- `automation-audit-ops` — verification audit trail

## How to use

1. Install the six new skills globally (above).
2. Open `docs/vps-claude-code-mcp-sop.md`.
3. Fill the D1–D10 decision table at the top.
4. Walk Phases A → H. At each phase, the SOP names the skill that backs it.
5. Tick the verification checklist in Phase H before declaring production.

## When to use which auth layer

| You need | Use |
|---|---|
| Claude Code CLI on laptop, custom agents, curl, server-to-server only | static bearer (the `mcp-bearer-gateway` skill, or `runtime/oauth-proxy.js` — both work) |
| claude.ai web custom connector | OAuth — `runtime/oauth-proxy.js` (claude.ai dialog has no field for a static bearer) |
| Claude mobile apps (iOS/Android via claude.ai) | OAuth — same as above |
| Mix of CLI and claude.ai for the same operator | `runtime/oauth-proxy.js` — both bearers work on the same `/mcp` endpoint |

If unsure, deploy `runtime/oauth-proxy.js`. It's strictly additive — the static-bearer CLI path keeps working when OAuth is enabled.

## Scope

**In scope:** provision VPS → harden → install Claude Code → expose its MCP over an authenticated tunnel.

**Out of scope (covered elsewhere):**
- Routines / scheduled agents
- Per-project skills authoring
- Softeria MS365 MCP self-hosting (addon — see `docs/softeria-mcp-*.md` in the parent repo)

## Portability

This bundle has no dependency on the parent `routines-claude` repo. To move it:

```bash
cp -r vps-bootstrap/ /path/to/other/repo/
```

Then in the new location, re-run the global skills install (it's idempotent).
