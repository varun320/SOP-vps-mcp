---
id: VPS-CLAUDE-CODE-MCP-SOP
title: SOP — Professional VPS setup with Claude Code exposed as an MCP server
status: draft
date: 2026-06-12
audience: solo operator or small team standing up a remote Claude Code workstation
scope:
  - provision and harden a generic Linux VPS (any provider)
  - install Claude Code under a non-root service user
  - expose Claude Code's MCP server endpoint over a secure tunnel
out_of_scope:
  - routines, schedules, skills (covered in separate docs)
  - Softeria / MS365 MCP self-hosting (separate addon — see related docs)
related:
  - docs/softeria-mcp-self-hosting-plan.md  (future addon — MS365 MCP on the same box)
  - docs/softeria-mcp-vps-runbook.md        (worked example using Hostinger + Tailscale)
  - docs/softeria-mcp-disaster-recovery.md  (DR patterns reusable here)
---

# SOP — VPS + Claude Code + MCP exposure

A vendor-neutral, production-grade procedure to stand up a Linux VPS, install Claude Code as a service user, and expose Claude Code's MCP interface to authorised clients over an encrypted tunnel.

This SOP is the **base layer**. Layering additional MCP servers (Softeria MS365, Playwright, custom skills) on top is covered in separate addon docs.

---

## 0. Decisions you must make before starting

Fill these in once, paste them at the top of your private runbook. Every command below references one of these placeholders.

| ID  | Decision                          | Recommended default                                  | Notes |
|-----|-----------------------------------|------------------------------------------------------|-------|
| D1  | VPS provider                      | Hostinger / Hetzner / DigitalOcean / Vultr           | Any KVM 2 vCPU / 4 GB RAM / 40 GB SSD is enough |
| D2  | OS image                          | Ubuntu 24.04 LTS                                     | Debian 12 also fine; commands below assume `apt` |
| D3  | Service user                      | `claude`                                             | Never run Claude Code as `root` |
| D4  | Tunnel / ingress                  | **Tailscale Funnel** (auth + TLS in one)             | Alternatives: Cloudflare Tunnel, WireGuard-only (private), Caddy + Let's Encrypt + bearer |
| D5  | MCP auth model                    | Bearer token in `Authorization` header               | Generate with `openssl rand -hex 32` |
| D6  | Process supervisor                | `systemd`                                            | Survives reboot, restarts on crash, journald logs |
| D7  | Secret storage                    | `.env` file mode `600`, owned by service user        | Or systemd `LoadCredential=` for hardened setups |
| D8  | Monitoring                        | UptimeRobot (free) → email                           | Probes the public tunnel URL `/health` |
| D9  | Backup cadence                    | Weekly token-cache + `.env` to password manager      | Plus provider snapshots if available |
| D10 | Rotation cadence                  | Bearer token + tunnel auth-key quarterly             | Calendar reminder, not ad-hoc |

Placeholders used throughout:

| Placeholder         | Example                                     |
|---------------------|---------------------------------------------|
| `<VPS_IP>`          | `203.0.113.42`                              |
| `<SERVICE_USER>`    | `claude`                                    |
| `<TS_HOSTNAME>`     | `cc-prod`                                   |
| `<TS_TAILNET>`      | `tailfe8c.ts.net`                           |
| `<PUBLIC_URL>`      | `https://<TS_HOSTNAME>.<TS_TAILNET>`        |
| `<BEARER_TOKEN>`    | 64-char hex from `openssl rand -hex 32`     |
| `<ANTHROPIC_KEY>`   | `sk-ant-...` from console.anthropic.com     |

---

## Phase A — Provision and harden the VPS (~20 min)

### A1. SSH in and update

```bash
ssh root@<VPS_IP>
apt update && apt -y upgrade
apt -y install ufw fail2ban curl wget gnupg2 ca-certificates lsb-release \
               apt-transport-https unattended-upgrades jq git build-essential
dpkg-reconfigure -plow unattended-upgrades   # enable auto security updates
```

### A2. Create the service user (D3)

```bash
useradd -m -s /bin/bash <SERVICE_USER>
mkdir -p /home/<SERVICE_USER>/.config
chown -R <SERVICE_USER>:<SERVICE_USER> /home/<SERVICE_USER>/.config
chmod 700 /home/<SERVICE_USER>/.config
# allow service user to use systemctl --user later
loginctl enable-linger <SERVICE_USER>
```

### A3. Firewall — deny-by-default

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH (closed after tunnel SSH verified)'
ufw --force enable
ufw status verbose
```

Do **not** open 80/443. The tunnel (Phase D) does not bind to public ports on this host.

### A4. fail2ban for SSH

```bash
systemctl enable --now fail2ban
fail2ban-client status sshd
```

### A5. Lock down SSH (after you've added your key)

#### A5.1 Add the operator's pubkey — base64-safe path

If you're using a real SSH client on your laptop (PowerShell OpenSSH, PuTTY, Terminal.app), `ssh-copy-id root@<VPS_IP>` works. **If you're using the provider's browser web terminal** (Hostinger's especially), pasting an SSH key directly corrupts it: the terminal hard-wraps at column ~80 and inserts leading whitespace on wrapped lines, silently splitting your key across multiple lines or merging key material into the comment field. sshd then rejects the resulting `authorized_keys` and the failure is indistinguishable from "wrong key".

The reliable way around this is to base64-encode the pubkey before transit (base64 has no whitespace the terminal will reflow):

```bash
# on the laptop
KEYLINE='ssh-ed25519 AAAA... operator@laptop'
echo -n "$KEYLINE" | base64 -w0
# → e.g. c3NoLWVkMjU1MTkgQUFBQS4uLi4uIG9wZXJhdG9yQGxhcHRvcA==
```

```bash
# on the VPS (single short line — survives any reflow)
echo <BASE64_BLOB>|base64 -d>>~/.ssh/authorized_keys
chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
wc -l ~/.ssh/authorized_keys   # one line per key, no more
```

Verify each line of `authorized_keys` starts with `ssh-ed25519` / `ssh-rsa` and ends in a comment before moving on. A broken key here cascades into Phase D pain.

#### A5.2 Disable password auth and lock root login

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
# Ubuntu cloud images ship a drop-in that re-enables password auth — override it:
grep -lr '^PasswordAuthentication' /etc/ssh/sshd_config.d/ 2>/dev/null \
  | xargs -r sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/'
systemctl restart ssh
sshd -T | grep -E '^(passwordauthentication|permitrootlogin)'
# expect: passwordauthentication no, permitrootlogin without-password
```

Without the `sshd_config.d/` override, your top-level edit *looks* applied but `sshd -T` quietly reports `passwordauthentication yes` because the drop-in wins. This bites on Ubuntu 22.04+ and most cloud images.

### A6. Hostname + timezone

```bash
hostnamectl set-hostname <TS_HOSTNAME>
timedatectl set-timezone UTC      # UTC everywhere; convert at display time
```

**Checkpoint A:** `ufw status` shows only 22/tcp. `fail2ban-client status sshd` shows active. `ssh root@<VPS_IP>` works with key, fails with password.

---

## Phase B — Install Node.js + Claude Code as the service user (~10 min)

### B1. Node.js LTS via NodeSource

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt -y install nodejs
node -v   # expect v20.x or v22.x
npm -v
```

### B2. Install Claude Code globally (system-wide binary, runs as service user)

```bash
npm install -g @anthropic-ai/claude-code
which claude   # /usr/bin/claude or /usr/local/bin/claude
claude --version
```

### B3. Switch to the service user and configure auth

```bash
su - <SERVICE_USER>
mkdir -p ~/.config/claude
```

Pick **one** auth path:

#### (a) Subscription login — recommended for solo operators with Max/Pro

Zero marginal cost, uses your existing Anthropic subscription. Requires a one-time browser flow.

```bash
claude login
# CLI prints a device-code URL — open it in your browser on your laptop,
# sign in with your Anthropic account, the CLI detects completion automatically.
# Credentials land at ~/.claude/.credentials.json (mode 600, auto-refreshes).
```

#### (b) API key — required if no browser available

Pay-per-token, billed via console.anthropic.com.

```bash
cat > ~/.config/claude/.env <<'EOF'
ANTHROPIC_API_KEY=<ANTHROPIC_KEY>
EOF
chmod 600 ~/.config/claude/.env
```

#### (c) AWS Bedrock or Google Vertex AI — for AWS/GCP-resident operators

```bash
# Bedrock
export CLAUDE_CODE_USE_BEDROCK=1
# place AWS creds at ~/.aws/credentials (mode 600, owned by service user)

# Vertex AI
export CLAUDE_CODE_USE_VERTEX=1
# place GCP service-account JSON at ~/.config/gcloud/key.json
```

### B4. Smoke-test Claude Code

```bash
# still as <SERVICE_USER>
mkdir -p ~/workspace && cd ~/workspace
echo "Say hello in five words." | claude --print
```

You should get a five-word response. If you used path (a), the API key must be in the environment — see Phase E for how systemd loads it.

**Checkpoint B:** `claude --print` returns text. The `.env` file is mode `600` and owned by `<SERVICE_USER>`.

---

## Phase C — Generate the MCP bearer token and project layout (~5 min)

### C1. Generate the bearer token (D5)

On the VPS, as `<SERVICE_USER>`:

```bash
openssl rand -hex 32 > ~/.config/claude/mcp-bearer.token
chmod 600 ~/.config/claude/mcp-bearer.token
cat ~/.config/claude/mcp-bearer.token   # copy this — clients need it
```

Store the value in your password manager alongside the Anthropic key.

### C2. Layout for the MCP-serving workspace

```bash
mkdir -p ~/workspace/mcp-host
cd ~/workspace/mcp-host
git init -q
# this directory becomes the "project root" Claude Code operates against
# when serving as an MCP server. Mount real projects here later via git clone or bind mounts.
```

---

## Phase D — Install Tailscale and enable Funnel (~10 min)

This is the recommended ingress for a small-team / solo-operator setup. It gives you:
- **Authenticated tunnel** to the VPS without opening 80/443 publicly
- **Free auto-renewing TLS** at `https://<TS_HOSTNAME>.<TS_TAILNET>`
- **Tailscale SSH** so you can close public port 22 afterwards

If you must use a different ingress, see "Alternative ingress" at the end.

### D1. Install Tailscale (as root)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

### D2. Join the tailnet with SSH enabled

```bash
tailscale up --ssh --hostname=<TS_HOSTNAME> --accept-routes=false
```

Open the URL it prints, authenticate, approve the machine in the admin console.

### D3. Enable Funnel (public HTTPS ingress through Tailscale)

Funnel requires per-tailnet enablement at https://login.tailscale.com → DNS → HTTPS → Enable, then Access Controls → Funnel → allow your machine.

```bash
# tell Funnel to forward public TLS → local plaintext on 127.0.0.1:8787
tailscale funnel --bg --https=443 http://127.0.0.1:8787
tailscale funnel status
# expect: https://<TS_HOSTNAME>.<TS_TAILNET> (Funnel on) → http://127.0.0.1:8787
```

### D4. Verify TLS edge

From your laptop:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<TS_HOSTNAME>.<TS_TAILNET>/
# nothing's serving yet, so a connection-refused or 502 is expected — but TLS handshake must succeed
```

### D5. Close public SSH

Once `tailscale ssh <SERVICE_USER>@<TS_HOSTNAME>` works from your laptop:

```bash
ufw delete allow 22/tcp
ufw status verbose   # confirm no public ingress remains
```

**Checkpoint D:** Funnel URL terminates TLS. SSH only reachable over the tailnet.

---

## Phase E — Run Claude Code as an MCP server under systemd (~10 min)

Claude Code ships a built-in MCP server mode (`claude mcp serve`) that exposes its tools to remote MCP clients over stdio. We need two things on top: an HTTP transport (so clients can speak to it over the network) and an auth boundary (so only authorised clients can).

### The architecture

```
internet ─TLS─▶ Tailscale Funnel ─tailnet─▶ 127.0.0.1:8787 (oauth-proxy.js)
                                                        │
                                                        │  Validates Authorization: Bearer <…>
                                                        │  Accepts static bearer (CLI path)
                                                        │  OR OAuth access token (claude.ai path)
                                                        ▼
                                              127.0.0.1:8788 (supergateway)
                                                        │
                                                        │  stdio JSON-RPC
                                                        ▼
                                              `claude mcp serve` (child process)
```

### Why two processes — and what NOT to try

A natural-looking but wrong design is "use `supergateway --oauth2Bearer …` as the auth layer". `supergateway`'s `--oauth2Bearer` flag is **outbound**: it decorates calls supergateway makes to upstream services. It does **not** validate inbound `Authorization` headers from clients. Using it for inbound auth produces a wide-open MCP server. Discovering this mid-deploy forces a redesign.

The correct split is:
- **`supergateway`** does one thing: bridge stdio ↔ HTTP. It binds to loopback `:8788` and is unreachable from the network.
- **`oauth-proxy.js`** (in this bundle's `runtime/`) does auth and routing. It binds to loopback `:8787`, validates every request, and proxies authorized traffic to `:8788`.

Two co-located systemd units, both running as `<SERVICE_USER>`. Each is small and does one thing.

### Auth model — pick what the operator needs

| Path | Use when | Surfaces |
|---|---|---|
| **Static bearer only** | CLI-only access (`claude mcp add ... --header`), custom scripts, server-to-server | Claude Code CLI, curl, custom agents |
| **Static bearer + OAuth 2.1** | Want claude.ai web/mobile custom-connector access | All of the above **plus** claude.ai web + Claude mobile apps |

claude.ai's custom-connector dialog only accepts OAuth (no field for a static bearer). If the operator needs claude.ai web/mobile access, the OAuth layer is mandatory. The OAuth layer is also strictly additive — turning it on does not break the CLI path; both bearers continue to work on the same `/mcp` endpoint.

### E1. Install supergateway

```bash
# as root
npm install -g supergateway
which supergateway
```

### E2. Install the auth proxy

The bundle ships `runtime/oauth-proxy.js` as the canonical implementation. It implements the MCP 2025-06 OAuth 2.1 spec (RFC 7591 Dynamic Client Registration + PKCE S256 + RFC 8414 AS metadata + RFC 9728 protected resource metadata) plus the legacy static-bearer path on the same `/mcp` endpoint.

```bash
# from operator's laptop (assumes the vps-bootstrap/ bundle is checked out locally)
scp vps-bootstrap/runtime/oauth-proxy.js root@<VPS_IP>:/tmp/oauth-proxy.js

# on the VPS:
install -o <SERVICE_USER> -g <SERVICE_USER> -m 644 /tmp/oauth-proxy.js \
  /home/<SERVICE_USER>/workspace/mcp-host/oauth-proxy.js
node --check /home/<SERVICE_USER>/workspace/mcp-host/oauth-proxy.js && echo OK
rm /tmp/oauth-proxy.js
```

For **CLI-only deployments** that don't want OAuth, you can skip this and use a 40-line bearer-only proxy instead — see `skills/mcp-bearer-gateway/SKILL.md` in this bundle. The systemd unit below is the same shape either way; only the `ExecStart` script changes.

### E3. Compose the environment file

As `<SERVICE_USER>`:

```bash
cat > ~/.config/claude/mcp.env <<EOF
MCP_BEARER_TOKEN=$(cat ~/.config/claude/mcp-bearer.token)
MCP_BIND_ADDR=127.0.0.1
MCP_PORT=8787
UPSTREAM_PORT=8788
OAUTH_ISSUER=https://<TS_HOSTNAME>.<TS_TAILNET>
OAUTH_LOGIN_PASSWORD=$(openssl rand -hex 16)
OAUTH_STATE_PATH=/home/<SERVICE_USER>/.config/claude/oauth-state.json
EOF
chmod 600 ~/.config/claude/mcp.env

# capture the password to surface to the operator — they paste it on /oauth/authorize
grep OAUTH_LOGIN_PASSWORD ~/.config/claude/mcp.env
```

If you authenticated Claude Code via API key (Phase B3 path b), also add `ANTHROPIC_API_KEY=<ANTHROPIC_KEY>`. Subscription login (B3 path a) needs nothing here — credentials live in `~/.claude/.credentials.json` and `claude mcp serve` finds them via `$HOME`.

### E4. Two systemd units

As root, create `/etc/systemd/system/claude-mcp-stdio.service`:

```ini
[Unit]
Description=Claude Code MCP (supergateway: stdio -> loopback HTTP)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=<SERVICE_USER>
Group=<SERVICE_USER>
WorkingDirectory=/home/<SERVICE_USER>/workspace/mcp-host
Environment=HOME=/home/<SERVICE_USER>
EnvironmentFile=/home/<SERVICE_USER>/.config/claude/mcp.env
ExecStart=/usr/bin/supergateway --stdio "/usr/bin/claude mcp serve" --outputTransport streamableHttp --port ${UPSTREAM_PORT} --streamableHttpPath /mcp --logLevel info
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

And `/etc/systemd/system/claude-mcp-auth.service`:

```ini
[Unit]
Description=Claude MCP edge auth-proxy (OAuth 2.1 + static bearer -> loopback supergateway)
After=network-online.target claude-mcp-stdio.service
Requires=claude-mcp-stdio.service
Wants=network-online.target

[Service]
Type=simple
User=<SERVICE_USER>
Group=<SERVICE_USER>
WorkingDirectory=/home/<SERVICE_USER>/workspace/mcp-host
Environment=HOME=/home/<SERVICE_USER>
EnvironmentFile=/home/<SERVICE_USER>/.config/claude/mcp.env
ExecStart=/usr/bin/node /home/<SERVICE_USER>/workspace/mcp-host/oauth-proxy.js
Restart=on-failure
RestartSec=3s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

**Hardening directives we deliberately do NOT use, and why:**

| Directive | Why omitted |
|---|---|
| `ProtectSystem=strict` | Blocks `/usr/lib/node_modules` reads supergateway needs unless every path is added to `ReadWritePaths`. `full` is the working ceiling. |
| `ProtectHome=read-only` | `claude mcp serve` writes session and credential files under `$HOME`. Read-only home produces cryptic stdio EOF errors. |
| `MemoryDenyWriteExecute=true` | Node's V8 JIT needs writable+executable mappings. Setting this crashes Node on startup with `Trace/breakpoint trap`. |

The setup above is the practical maximum that still runs. If you want stricter isolation, containerise the unit (see `docker-patterns`) — the kernel-namespace approach works around the Node-JIT vs systemd-MDWX conflict.

Then:

```bash
systemctl daemon-reload
systemctl enable --now claude-mcp-stdio.service claude-mcp-auth.service
sleep 3
systemctl is-active claude-mcp-stdio claude-mcp-auth
journalctl -u claude-mcp-stdio -n 20 --no-pager
journalctl -u claude-mcp-auth  -n 20 --no-pager
ss -ltnp | grep -E ':(8787|8788)'   # expect both bound to 127.0.0.1
```

### E5. Smoke-test the full chain

```bash
TOKEN=$(cat /home/<SERVICE_USER>/.config/claude/mcp-bearer.token)
PUB="https://<TS_HOSTNAME>.<TS_TAILNET>"

# (a) Health endpoint — no auth
curl -sS -m 10 "$PUB/health"   # expect: ok

# (b) Unauthenticated /mcp → 401 WITH WWW-Authenticate pointing at metadata
curl -sS -m 10 -D - -o /dev/null "$PUB/mcp" | grep -i www-authenticate
# expect: Bearer realm="mcp", resource_metadata="https://.../.well-known/oauth-protected-resource"

# (c) Authenticated /mcp via static bearer → MCP initialize frame
curl -sS -m 10 -X POST "$PUB/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# (d) OAuth metadata endpoints (only if OAuth layer is in use)
curl -sS -m 10 "$PUB/.well-known/oauth-protected-resource"
curl -sS -m 10 "$PUB/.well-known/oauth-authorization-server"
```

**Checkpoint E:** both units `active`. Test (a) returns `ok`. Test (b) returns 401 **and** the `WWW-Authenticate` header is present (without it, claude.ai will not auto-discover OAuth). Test (c) returns a `serverInfo` block containing `claude/tengu`. If OAuth is enabled, (d) returns two JSON metadata documents.

---

## Phase F — Register the MCP server with clients (~5 min)

### F1. From another Claude Code instance (your laptop)

```bash
claude mcp add --transport http remote-claude \
    https://<TS_HOSTNAME>.<TS_TAILNET>/mcp \
    --header "Authorization: Bearer <BEARER_TOKEN>"
claude mcp list
```

### F2. From claude.ai (web / mobile / cloud routines) — requires the OAuth layer

claude.ai's custom-connector dialog **does not accept a static bearer token**. If you only deployed the static-bearer proxy, this path will not work — go back to Phase E2 and install `oauth-proxy.js`.

Settings → Connectors → **Add custom connector**:
- Name: anything (e.g. `remote-claude`)
- URL: `https://<TS_HOSTNAME>.<TS_TAILNET>/mcp`
- OAuth Client ID + Client Secret: **leave both blank** — Dynamic Client Registration runs automatically.

After **Add**, claude.ai redirects you to `/oauth/authorize`. Paste the `OAUTH_LOGIN_PASSWORD` from `mcp.env`, click **Approve**. claude.ai exchanges the resulting code for an access token with refresh and the connector turns green. From then on, the same connector works in claude.ai web and the Claude mobile apps.

### F3. From a project's `.mcp.json`

```json
{
  "mcpServers": {
    "remote-claude": {
      "type": "http",
      "url": "https://<TS_HOSTNAME>.<TS_TAILNET>/mcp",
      "headers": { "Authorization": "Bearer <BEARER_TOKEN>" }
    }
  }
}
```

**Never commit `.mcp.json` with the literal token.** Use env-var interpolation or a `.mcp.json.template`.

---

## Phase G — Health, monitoring, rotation (~10 min)

### G1. Health endpoint

Add a trivial `/health` route via a 20-line reverse proxy in front of supergateway, or have UptimeRobot probe the bearer-protected `/mcp` with the expected 200/JSON-RPC response and an "Authorization" custom header.

### G2. UptimeRobot (D8)

- Monitor type: HTTPS keyword
- URL: `https://<TS_HOSTNAME>.<TS_TAILNET>/mcp`
- Headers: `Authorization: Bearer <BEARER_TOKEN>`
- Keyword: `jsonrpc`
- Interval: 5 min
- Alert contacts: your email

### G3. Quarterly rotation (D10)

Calendar reminder every 90 days:

1. `openssl rand -hex 32 > ~/.config/claude/mcp-bearer.token.new`
2. Update `~/.config/claude/mcp.env` with the new token
3. `sudo systemctl restart claude-mcp`
4. Update all client registrations (claude.ai connector, laptop `claude mcp`, `.mcp.json`)
5. Confirm green probe in UptimeRobot
6. Delete `.token` (old) from password manager, save new one

Same cadence for Tailscale auth-key if you use one (`tailscale up --authkey`).

### G4. Backups (D9)

Weekly:
- copy `~/.config/claude/mcp.env` + `~/.config/claude/mcp-bearer.token` to password manager attachment
- provider snapshot of the whole VPS if supported

---

## Phase H — Verification checklist before declaring "production"

- [ ] `ufw status` shows no public ports except what the tunnel needs (none for Tailscale Funnel)
- [ ] `ssh root@<VPS_IP>` fails (closed); `tailscale ssh <SERVICE_USER>@<TS_HOSTNAME>` succeeds
- [ ] `systemctl status claude-mcp` shows `active (running)` after a `reboot`
- [ ] `curl` to public URL **without** bearer returns 401
- [ ] `curl` to public URL **with** bearer returns valid MCP JSON-RPC
- [ ] `journalctl -u claude-mcp --since "1 hour ago"` is clean
- [ ] UptimeRobot monitor is green
- [ ] Bearer token + tunnel auth-key are in the password manager
- [ ] Quarterly rotation reminder is on the calendar
- [ ] Secrets (`.env`, `.token`) are mode `600` and owned by `<SERVICE_USER>`

---

## Alternative ingress (if not using Tailscale)

### Cloudflare Tunnel

```bash
# install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create claude-mcp
cloudflared tunnel route dns claude-mcp <subdomain>.<your-domain>
# config.yml routes the hostname → http://127.0.0.1:8787
systemctl enable --now cloudflared
```

### Caddy + Let's Encrypt + bearer (public A-record)

Open 80/443, point DNS, install Caddy, reverse-proxy `127.0.0.1:8787` with a `header_up Authorization` check or an `forward_auth` validator. More moving parts, more attack surface — only choose this if your environment forbids tunnels.

### Private-only (WireGuard or tailnet without Funnel)

Skip Phase D's Funnel step. Clients must be on the same WireGuard / tailnet to reach the MCP endpoint. Most secure, least convenient.

---

## Troubleshooting cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` from public URL | Bearer mismatch | Re-paste token; check no trailing newline in `.env` |
| `502 Bad Gateway` from Funnel | systemd unit crashed | `journalctl -u claude-mcp -n 200` |
| `claude mcp serve` exits immediately | Missing `ANTHROPIC_API_KEY` or login | Check `EnvironmentFile=` loaded; re-run `claude login` as service user |
| Funnel URL hangs | Funnel disabled in tailnet ACL | https://login.tailscale.com → DNS / Access Controls |
| `Permission denied` writing to workspace | `ProtectHome=read-only` blocking | Add path under `ReadWritePaths=` in unit file |
| `EADDRINUSE :8787` | Old `supergateway` still bound | `pkill -f supergateway` then `systemctl restart claude-mcp` |
| Tailscale Funnel not free anymore | Plan limits changed | Switch to Cloudflare Tunnel (Alternative ingress) |

---

## What this SOP deliberately leaves out

- **Routines / scheduled agents** — covered separately; once this base is green, layer them on by registering them against this MCP endpoint.
- **Skills** — install per-project under `~/.claude/skills/` as normal; no infra change needed.
- **Softeria MS365 MCP** — addon. After this base is green, follow `docs/softeria-mcp-self-hosting-plan.md` to colocate it as a second systemd unit behind the same tunnel under a different path (e.g. `/ms365`).
- **Multi-tenant isolation** — if more than one operator shares the box, run one systemd unit per user with one bearer per tenant, and route by path prefix on the tunnel side.

---

## Skills required to run this SOP

Three classes of skills support this procedure: **existing skills** (installed globally already), **new skills** authored alongside this SOP, and **future addons**.

### Required existing skills (install before starting)

| Skill | Why |
|---|---|
| `mcp-server-patterns` | Phase E — MCP framing, stdio vs HTTP transport choice, supergateway/mcp-proxy patterns |
| `deployment-patterns` | Phases A + E — systemd hardening directives, rollout discipline |
| `terminal-ops` | All phases — disciplined, idempotent shell work on the VPS |

### New skills authored for this SOP (in `vps-bootstrap/skills/`)

| Skill | Phase | Purpose |
|---|---|---|
| `vps-provisioning` | A + D | Deny-by-default UFW, fail2ban, unattended-upgrades, SSH key-only, Tailscale join — provider-agnostic |
| `tunnel-ingress` | D | Chooser + recipes for Tailscale Funnel vs Cloudflare Tunnel vs Caddy + Let's Encrypt |
| `systemd-service-hardening` | E | Sandbox directives generalised (`ProtectSystem`, `ReadWritePaths`, `MemoryDenyWriteExecute`) |
| `claude-code-headless` | B + E | Running Claude Code non-interactively under a service user; API key vs login tradeoffs |
| `mcp-bearer-gateway` | E | Wrapping a stdio MCP server with authenticated HTTP (bearer validation, 401 behaviour, monitoring) |
| `secret-rotation` | G | Bearer + tunnel key + API key rotation log, client-update fan-out checklist |

### Optional / situational skills

| Skill | When |
|---|---|
| `docker-patterns` | If you containerise Phase E instead of bare systemd |
| `api-connector-builder` | Phase F — wiring the MCP into non-Claude clients |
| `github-ops` | Phase C — managing `mcp-host` workspace, deploy keys |
| `automation-audit-ops` | Phase H — verification audit trail |
| `enterprise-agent-ops` | Multi-tenant setups (one bearer per operator) |

### Recommendation

For the **first setup**, the strict minimum is the three existing skills (`mcp-server-patterns`, `deployment-patterns`, `terminal-ops`) plus this SOP. They get you to green.

Layer in the six new skills before the **second** VPS — they collapse the 4-hour first-run into a 30-minute repeat.

A portable bundle of this SOP plus the six new skills is at `vps-bootstrap/` at the repo root, designed to be copied wholesale into another repo.

---

## Change log

- 2026-06-12 — initial draft (vendor-neutral; Tailscale Funnel recommended path).
- 2026-06-12 — added "Skills required" section pointing to `vps-bootstrap/` bundle.
- 2026-06-12 — production hardening pass after a real Hostinger deploy:
  - Phase A5 expanded with the base64-encoded SSH-key install pattern (browser web terminals like Hostinger's silently corrupt direct pubkey pastes by inserting whitespace on wrapped lines) and the `sshd_config.d/` drop-in override (Ubuntu cloud images re-enable password auth from a drop-in that overrides the top-level config).
  - Phase B3 reordered to put subscription login (Claude Max/Pro) first as the recommended path for solo operators; API key path retained for headless-only environments; Bedrock/Vertex paths added.
  - Phase E rewritten end-to-end. The original `supergateway --bearer ${MCP_BEARER_TOKEN}` ExecStart does not validate inbound requests — `--oauth2Bearer` is an outbound header decorator and there is no inbound auth flag in supergateway. Replaced with a two-tier architecture: supergateway on loopback `:8788` doing only stdio↔HTTP, fronted by `runtime/oauth-proxy.js` on `:8787` doing auth + routing. Two systemd units, both as the service user. The proxy implements the MCP 2025-06 OAuth 2.1 spec (RFC 7591 Dynamic Client Registration + PKCE S256 + RFC 8414/9728 metadata) **plus** the legacy static bearer on the same `/mcp` endpoint, so the CLI path and claude.ai web path coexist.
  - Phase E hardening: `ProtectSystem=strict`, `ProtectHome=read-only`, and `MemoryDenyWriteExecute=true` removed from the unit files — all three break Node's V8 JIT or Claude Code's `$HOME` writes. Practical maximum documented inline.
  - Phase F2 updated: claude.ai web custom-connector does not accept static bearer tokens (no header field); requires the OAuth layer from Phase E2.
  - `runtime/oauth-proxy.js` added to the bundle as the canonical implementation; Phase E2 references it directly.
