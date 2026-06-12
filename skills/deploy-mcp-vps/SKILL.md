---
name: deploy-mcp-vps
description: End-to-end procedure to stand up a hardened Linux VPS that exposes Claude Code as an authenticated MCP server reachable from claude.ai web/mobile, Claude Code CLI, and custom clients — via Tailscale Funnel for TLS+ingress, systemd for supervision, OAuth 2.1 + static-bearer dual auth at the edge, and an optional Softeria MS365 MCP unit on the same host. **Use this skill whenever the user asks to deploy, provision, or set up a "VPS with Claude Code", a "remote MCP server", a "self-hosted Claude Code", "Claude Code on a server / Hostinger / Hetzner / DO / Vultr", a "Tailscale Funnel MCP", an "OAuth MCP gateway", or wants to make their Claude Code reachable from mobile or claude.ai — even if they don't explicitly say "skill" or "deploy". Also use when the user is debugging or rebuilding any phase of an existing such deployment (SSH hardening, Tailscale Funnel, systemd MCP units, OAuth proxy, bearer rotation).** Blocks on missing prerequisites rather than producing a half-deployed box.
---

# deploy-mcp-vps

End-to-end procedure for: blank Linux VPS → hardened, Tailscale-fronted, OAuth-authenticated, systemd-supervised Claude Code MCP server reachable by humans and agents from anywhere.

This skill is **the executable form** of `vps-bootstrap/docs/vps-claude-code-mcp-sop.md`. The SOP is the source of truth for *why*; this skill is the source of truth for *what to run, in what order, with what guard-rails*.

## When to refuse / handoff

- **Use a different skill** for routines / scheduled cloud agents (`schedule`, `routines`), per-project skill authoring (`skill-generator`), or claude.ai connector troubleshooting on a server you don't control. Those are out of scope.
- **Stop and ask the user** before running this on a box that already has a `claude` service user, an existing `claude-mcp-*` systemd unit, or a `tailscale` interface. Re-deploying without consent overwrites their setup.

## The single most important rule

**Block on missing prerequisites. Do not "best-effort" a partial deploy.** A half-provisioned box that *seems* to work hides failure modes that surface days later (cert auto-renewal silently broken, fail2ban not running, OAuth proxy without persistence, root SSH still passworded). Every phase below has an explicit gate; do not advance past a failed gate by guessing.

The reason is operational: if anything in phases A–H fails halfway, the recovery procedure is "destroy the VPS and retry", not "patch in place". A clean half-baked output is worse than a clear blocker, because nobody comes back to fix the half-baked one.

---

## Phase 0 — Prerequisite gate (blocking)

Before any command runs on the target VPS, confirm every item below. If even one is missing, **stop and surface the gap to the user**. Do not proceed.

| # | Prerequisite | Where it comes from | Default if omitted |
|---|---|---|---|
| 1 | `VPS_IP` (root-SSH-reachable, freshly provisioned) | User's VPS provider (Hostinger / Hetzner / DO / Vultr) | **BLOCK** |
| 2 | Initial root credentials (password OR pre-installed key) | Provider email or hPanel | **BLOCK** |
| 3 | `VPS_OS=ubuntu-24.04` (or Debian 12) | User chose at order | **BLOCK** — script assumes apt |
| 4 | Tailscale account exists | https://tailscale.com signup | **BLOCK** |
| 5 | Tailscale Funnel enabled per-tailnet | Admin → DNS → HTTPS → Enable, then ACL `nodeAttrs: [{"target":["*"],"attr":["funnel"]}]` | **BLOCK** |
| 6 | `TS_TAILNET` (e.g. `tail7411c5.ts.net`) | Top of any Tailscale admin page | **BLOCK** |
| 7 | `TS_AUTH_KEY` (single-use, pre-approved, 90d expiry) | Admin → Settings → Keys → Generate auth key | Optional — fallback is interactive browser approve at Phase D2 |
| 8 | Anthropic auth choice | One of: **subscription** (Max/Pro `claude login` device flow), **api-key** (`ANTHROPIC_API_KEY`), **bedrock**, **vertex** | **BLOCK** |
| 9 | `TS_HOSTNAME` for the node | User preference | Default to `cc-prod` |
| 10 | Operator's SSH pubkey (the human will use Tailscale SSH later, but also needs out-of-band recovery if Tailscale ever breaks) | `~/.ssh/id_ed25519.pub` on their laptop | **BLOCK** until provided |

If acting as an agent and **also** SSH-ing in to drive the deploy: an additional pubkey (the agent's own `~/.ssh/id_ed25519.pub`) gets added during Phase A. Operator pubkey + agent pubkey are both installed.

After all blocks clear, restate the decisions back to the user in a single block and ask for explicit go-ahead before any command runs against the VPS. This is the last off-ramp before destructive work.

---

## Phase A — Provision and harden the VPS (~5 min)

### A1. Add operator + agent SSH keys WITHOUT corruption

The terminal-paste-mangling failure mode is real: browser SSH terminals (Hostinger's web shell especially) hard-wrap pasted text at column ~80 and insert leading whitespace on wrapped lines, splitting an SSH key across multiple lines or merging key material into the comment field. The same pubkey rejected by sshd looks visually identical to one accepted.

**Solution: base64-encode the pubkey before pasting.** Base64 has no whitespace that the terminal will reflow into.

For each pubkey you need to install:

```bash
# On the laptop (or in the agent's local env)
KEYLINE='ssh-ed25519 AAAA... operator@laptop'
echo -n "$KEYLINE" | base64 -w0
# → e.g. c3NoLWVkMjU1MTkgQUFBQS4uLi4uIG9wZXJhdG9yQGxhcHRvcA==
```

Then **on the VPS** (paste this one short command — it stays on one line and survives any reflow):

```bash
echo <BASE64_BLOB>|base64 -d>>~/.ssh/authorized_keys
```

After installing all required keys, verify:

```bash
chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
wc -l ~/.ssh/authorized_keys   # = (operator_keys + agent_keys), no more
cat ~/.ssh/authorized_keys     # each line starts with ssh-ed25519 / ssh-rsa and ends with a comment
```

Gate: every line is one full key. If any line breaks mid-key, redo this step — do not proceed.

### A2. System update + base packages

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y -qq upgrade
apt-get -y -qq install ufw fail2ban curl wget gnupg2 ca-certificates lsb-release \
                       apt-transport-https unattended-upgrades jq git build-essential
```

### A3. Create the service user

The whole MCP stack runs as a non-root `claude` user. Never run Claude Code or the OAuth proxy as root — credentials and tool execution happen here, and a compromise of those processes must not be a compromise of the host.

```bash
useradd -m -s /bin/bash claude
install -d -m 700 -o claude -g claude /home/claude/.config/claude
loginctl enable-linger claude
```

### A4. Firewall — deny-by-default

```bash
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH (closes after Tailscale SSH verified in D5)'
ufw --force enable
```

**Do not open 80/443.** Tailscale Funnel does not bind to public ports on this host; ingress arrives via Tailscale's distributed edge, never via your VPS's public NIC.

### A5. fail2ban + hostname + timezone

```bash
systemctl enable --now fail2ban
hostnamectl set-hostname "${TS_HOSTNAME:-cc-prod}"
timedatectl set-timezone UTC
```

### A6. Lock down SSH (key-only, no password)

This is safe to do now because the keys from A1 are confirmed working. The reason for doing it before Tailscale Funnel comes up: until D5 closes port 22 publicly, the attack surface is the entire internet hitting :22. Removing the password attack vector immediately matters.

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
# Ubuntu cloud images often ship a drop-in that re-enables password auth — override it:
grep -lr '^PasswordAuthentication' /etc/ssh/sshd_config.d/ 2>/dev/null \
  | xargs -r sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/'
systemctl restart ssh
sshd -T | grep -E '^(passwordauthentication|permitrootlogin)'
```

**Checkpoint A:** `ufw status` shows only 22/tcp. `fail2ban-client status sshd` is active. SSH with key succeeds, SSH with password is refused.

---

## Phase B — Install Node.js + Claude Code (~3 min)

### B1. Node.js (NodeSource LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null
apt-get -y -qq install nodejs
node -v   # expect v20+ (v22 / v24 fine)
```

### B2. Claude Code globally

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### B3. Authenticate as the service user (interactive — surface this to the user)

This step **requires a human at a browser**. Decide auth method by the prerequisite from Phase 0:

| Method | Command | Notes |
|---|---|---|
| **subscription** (Max / Pro) | `su - claude -c 'claude login'` — prints a device-code URL; user opens it, signs in with Anthropic account; tokens land at `/home/claude/.claude/.credentials.json` (mode 600, auto-refreshes) | Zero marginal cost. Best for solo operator. |
| **api-key** | `echo 'ANTHROPIC_API_KEY=sk-ant-...' > /home/claude/.config/claude/.env && chmod 600 /home/claude/.config/claude/.env && chown claude:claude /home/claude/.config/claude/.env` | Pay-per-token. Required if no browser available. |
| **bedrock** | `CLAUDE_CODE_USE_BEDROCK=1` + AWS creds at `/home/claude/.aws/credentials` (mode 600, owned by claude) | Needs Bedrock model access enabled in target region. |
| **vertex** | `CLAUDE_CODE_USE_VERTEX=1` + GCP SA JSON at `/home/claude/.config/gcloud/key.json` | Needs Vertex AI quota in target project. |

Smoke-test before moving on:

```bash
su - claude -c 'claude --print "Say hello in five words."'
```

Gate: returns five words. If it errors with `unauthenticated` or `missing api key`, do not advance — fix the auth path first.

---

## Phase C — Generate bearer + workspace (~1 min)

The static bearer is the dual-auth fallback. claude.ai web/mobile uses OAuth (Phase E2); the Claude Code CLI and `curl` / custom scripts use this token directly. Both call the same `/mcp` endpoint.

```bash
su - claude -c '
  openssl rand -hex 32 > ~/.config/claude/mcp-bearer.token
  chmod 600 ~/.config/claude/mcp-bearer.token
  mkdir -p ~/workspace/mcp-host
  cd ~/workspace/mcp-host && git init -q
  git config user.email claude@$(hostname) && git config user.name claude-code
'
```

Capture the token to surface to the user at the end — it must end up in their password manager *and* in client-side configs (`claude mcp add ... --header "Authorization: Bearer ..."`).

---

## Phase D — Tailscale + Funnel (~3 min)

### D1. Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

### D2. Join the tailnet

```bash
tailscale up --ssh --hostname="${TS_HOSTNAME:-cc-prod}" --accept-routes=false \
             --authkey="${TS_AUTH_KEY}"
tailscale status   # confirm cc-prod row appears with 100.x.y.z
tailscale ip -4
```

If `TS_AUTH_KEY` was omitted in prereqs, `tailscale up` prints a one-time approval URL — surface it to the user, wait for them to approve, then continue.

### D3. Enable Funnel forwarding 443 → loopback :8787

`:8787` is the OAuth proxy port (Phase E2). Funnel terminates TLS at Tailscale's edge and forwards plaintext over the encrypted tailnet to localhost on this box — no public port opens here.

```bash
tailscale funnel --bg --https=443 http://127.0.0.1:8787
tailscale funnel status
```

### D4. TLS edge sanity check

```bash
curl -m 10 -o /dev/null -w 'edge HTTP %{http_code}\n' https://${TS_HOSTNAME:-cc-prod}.${TS_TAILNET}/
# Connection-refused / 502 at app layer is fine for now (nothing on :8787 yet).
# TLS handshake completing is the gate.
```

### D5. Close public port 22 (after Tailscale SSH verified)

Only run this **after** the operator confirms `tailscale ssh root@${TS_HOSTNAME}` works from their laptop. Closing :22 without verifying Tailscale SSH locks them out (well, almost — the provider's KVM console is still the break-glass).

```bash
ufw delete allow 22/tcp
ufw status verbose
```

---

## Phase E — OAuth-MCP auth-proxy + Claude Code MCP server (~5 min)

The architecture: two co-located systemd units, both running as `claude`.

```
internet ─TLS─▶ Tailscale Funnel edge ─tailnet─▶ 127.0.0.1:8787 (oauth-proxy: bearer + OAuth)
                                                            │
                                                            ▼
                                                  127.0.0.1:8788 (supergateway → claude mcp serve via stdio)
```

The reason for two processes: `supergateway` is a transport bridge (stdio↔HTTP), not an auth gateway. Its `--oauth2Bearer` flag is **outbound** (decorates calls to upstream), not inbound. Trying to use it as an auth boundary is a mid-deployment redesign trap. Split responsibilities cleanly: supergateway only translates transport; `oauth-proxy.js` only does auth + routing.

### E1. Install supergateway

```bash
npm install -g supergateway
```

### E2. Install the OAuth proxy

The canonical source for `oauth-proxy.js` lives at `vps-bootstrap/runtime/oauth-proxy.js`. Push it to the VPS rather than embed it inline — keeps the skill prompt small and the file under version control.

```bash
# from operator's laptop:
scp vps-bootstrap/runtime/oauth-proxy.js root@${VPS_IP}:/tmp/oauth-proxy.js

# on the VPS:
install -o claude -g claude -m 644 /tmp/oauth-proxy.js \
  /home/claude/workspace/mcp-host/oauth-proxy.js
node --check /home/claude/workspace/mcp-host/oauth-proxy.js  # syntax gate
```

What the proxy does, briefly:
- Implements MCP 2025-06-18 OAuth 2.1 spec (RFC 7591 dynamic client registration + PKCE S256 + RFC 8414 AS metadata + RFC 9728 protected resource metadata).
- Exposes `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`.
- Validates `Authorization: Bearer …` on `/mcp`. Accepts **either** the static `MCP_BEARER_TOKEN` (CLI/curl path) **or** any unexpired OAuth-issued access token (claude.ai web/mobile path).
- 401 responses include `WWW-Authenticate: Bearer resource_metadata="…"` so spec-compliant MCP clients auto-discover OAuth without manual config.
- Persists OAuth state (clients, codes, tokens, refresh) to a single JSON file at `/home/claude/.config/claude/oauth-state.json` (mode 600).
- `/health` is public for monitoring; everything else under `/mcp` requires auth.

### E3. Compose the environment file

```bash
TOKEN=$(cat /home/claude/.config/claude/mcp-bearer.token)
PASS=$(openssl rand -hex 16)   # OAuth login password — single shared secret for the operator
sudo -u claude tee /home/claude/.config/claude/mcp.env >/dev/null <<EOF
MCP_BEARER_TOKEN=$TOKEN
MCP_BIND_ADDR=127.0.0.1
MCP_PORT=8787
UPSTREAM_PORT=8788
OAUTH_ISSUER=https://${TS_HOSTNAME:-cc-prod}.${TS_TAILNET}
OAUTH_LOGIN_PASSWORD=$PASS
OAUTH_STATE_PATH=/home/claude/.config/claude/oauth-state.json
EOF
chmod 600 /home/claude/.config/claude/mcp.env
echo "OAUTH_LOGIN_PASSWORD to give the user: $PASS"
```

Surface `$PASS` and `$TOKEN` to the user at the end — both go into their password manager.

### E4. Two systemd units

```bash
cat > /etc/systemd/system/claude-mcp-stdio.service <<'EOF'
[Unit]
Description=Claude Code MCP (supergateway: stdio -> loopback HTTP)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=claude
Group=claude
WorkingDirectory=/home/claude/workspace/mcp-host
Environment=HOME=/home/claude
EnvironmentFile=/home/claude/.config/claude/mcp.env
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
EOF

cat > /etc/systemd/system/claude-mcp-auth.service <<'EOF'
[Unit]
Description=Claude MCP edge auth-proxy (OAuth 2.1 + static bearer -> loopback supergateway)
After=network-online.target claude-mcp-stdio.service
Requires=claude-mcp-stdio.service
Wants=network-online.target

[Service]
Type=simple
User=claude
Group=claude
WorkingDirectory=/home/claude/workspace/mcp-host
Environment=HOME=/home/claude
EnvironmentFile=/home/claude/.config/claude/mcp.env
ExecStart=/usr/bin/node /home/claude/workspace/mcp-host/oauth-proxy.js
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
EOF

systemctl daemon-reload
systemctl enable --now claude-mcp-stdio.service claude-mcp-auth.service
sleep 3
systemctl is-active claude-mcp-stdio claude-mcp-auth
```

**Hardening note — what we deliberately omit:** `ProtectSystem=strict`, `ProtectHome=read-only`, and `MemoryDenyWriteExecute=true` all break Node (V8 JIT needs writable+executable mappings; supergateway needs to spawn `claude` which writes to `$HOME`). Using them produces a unit that fails on first invocation with cryptic errors. `ProtectSystem=full` + writable `$HOME` is the working ceiling.

### E5. Smoke-test the full path

```bash
TOKEN=$(cat /home/claude/.config/claude/mcp-bearer.token)
PUB="https://${TS_HOSTNAME:-cc-prod}.${TS_TAILNET}"
# 1. Health endpoint (no auth)
curl -sS -m 10 "$PUB/health"   # expect: ok
# 2. Unauthenticated /mcp → 401 with WWW-Authenticate
curl -sS -m 10 -D - -o /dev/null "$PUB/mcp" | grep -i www-authenticate
# 3. Authenticated /mcp via static bearer → MCP initialize frame
curl -sS -m 10 -X POST "$PUB/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
# 4. AS + protected-resource metadata
curl -sS -m 10 "$PUB/.well-known/oauth-protected-resource"
curl -sS -m 10 "$PUB/.well-known/oauth-authorization-server"
```

Gate: all four return expected output. If 401 has no `www-authenticate` header, claude.ai will not auto-discover OAuth — the proxy isn't running the version you think. If the initialize POST returns 502, `claude-mcp-stdio` died — check `journalctl -u claude-mcp-stdio -n 50`.

---

## Phase F — Register the MCP with clients

Two paths, pick whichever the user needs. They're not mutually exclusive.

### F1. Claude Code CLI (laptop, mobile via remote IDE, custom agents)

```bash
claude mcp add --transport http cc-prod \
  https://${TS_HOSTNAME}.${TS_TAILNET}/mcp \
  --header "Authorization: Bearer ${MCP_BEARER_TOKEN}"
claude mcp list
```

### F2. claude.ai web / mobile (Settings → Connectors → Add custom connector)

- Name: anything (e.g. `cc-prod`)
- URL: `https://${TS_HOSTNAME}.${TS_TAILNET}/mcp`
- OAuth Client ID + Secret: **leave blank** — Dynamic Client Registration runs automatically.
- After "Add", claude.ai redirects to `/oauth/authorize`. User pastes `OAUTH_LOGIN_PASSWORD`, approves, redirected back with an auth code, exchanged for a 1-hour access token (with refresh). Connector turns green.

### F3. Project `.mcp.json` (do not commit literal token)

```json
{"mcpServers":{"cc-prod":{"type":"http","url":"https://cc-prod.tail7411c5.ts.net/mcp","headers":{"Authorization":"Bearer ${MCP_BEARER_TOKEN}"}}}}
```

---

## Phase G — Monitoring + rotation

### G1. UptimeRobot probe

- Type: HTTPS keyword
- URL: `https://${TS_HOSTNAME}.${TS_TAILNET}/health`
- Keyword: `ok`
- Interval: 5 min
- Notify: operator email

Probing `/health` (not `/mcp`) avoids burning auth tokens on every probe. The `claude-mcp-auth` unit returns `/health` even if `claude-mcp-stdio` is down, so green here doesn't prove the full stack works; G2 covers that.

### G2. Deeper liveness probe (optional)

A second monitor: HTTPS keyword on `/mcp` with the static bearer in a custom Authorization header, keyword `jsonrpc`. Exercises the full chain.

### G3. Quarterly rotation (90-day cadence)

```bash
# on the VPS, as root:
NEW=$(openssl rand -hex 32)
sudo -u claude bash -c "echo $NEW > /home/claude/.config/claude/mcp-bearer.token && chmod 600 /home/claude/.config/claude/mcp-bearer.token"
sed -i "s/^MCP_BEARER_TOKEN=.*/MCP_BEARER_TOKEN=$NEW/" /home/claude/.config/claude/mcp.env
systemctl restart claude-mcp-auth
# then update every client: claude mcp add ... --header "Authorization: Bearer $NEW"
```

Rotate Tailscale auth key on the same calendar cadence.

---

## Phase H — Verification gate (the final blocker)

Do not declare done until **every** box is ticked:

- [ ] `ufw status` shows no public-internet ingress (Tailscale Funnel doesn't need any)
- [ ] Public `ssh root@${VPS_IP}` fails; `tailscale ssh root@${TS_HOSTNAME}` succeeds
- [ ] `systemctl is-active claude-mcp-stdio claude-mcp-auth tailscaled fail2ban ufw` returns `active` for all
- [ ] `systemctl is-enabled` returns `enabled` for the same five (survives reboot)
- [ ] `curl https://${TS_HOSTNAME}.${TS_TAILNET}/health` returns `ok`
- [ ] `curl https://${TS_HOSTNAME}.${TS_TAILNET}/mcp` (no auth) returns 401 **with** `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource`
- [ ] `curl -H "Authorization: Bearer $TOKEN" -X POST .../mcp -d '{...initialize...}'` returns a valid MCP frame
- [ ] OAuth dynamic client registration succeeds: `curl -X POST .../oauth/register -d '{}'` returns a `client_id`
- [ ] `journalctl -u claude-mcp-auth --since "10 min ago"` has no error lines
- [ ] `journalctl -u claude-mcp-stdio --since "10 min ago"` has no error lines
- [ ] Secrets at `/home/claude/.config/claude/` are mode 600 and owned by `claude`
- [ ] Operator's password manager contains: `MCP_BEARER_TOKEN`, `OAUTH_LOGIN_PASSWORD`, Tailscale account credentials
- [ ] Calendar reminder set for 90-day rotation
- [ ] Used Tailscale auth key revoked (if one was used in D2)

Surface the checklist to the user with each item's actual status. Anything unchecked = not done.

---

## Optional addon — Softeria MS365 MCP on the same host

If the user wants Softeria MS365 MCP running beside Claude Code on the same VPS (sharing the Funnel under a different path prefix like `/ms365`), don't try to retrofit it into `claude-mcp-stdio.service`. Co-locate as a third systemd unit on a third loopback port (`:8789`), and add a route in `oauth-proxy.js` that maps `/ms365` → `127.0.0.1:8789`. That work is its own SOP — see `docs/softeria-mcp-*.md` in the parent repo. Block on:

- Entra app registration with redirect URI matching `https://${TS_HOSTNAME}.${TS_TAILNET}/ms365/oauth/callback`
- Softeria MS365 MCP build artifact + service-account creds in env file at mode 600
- Decision on which authentication tier (delegated vs application permissions) per the user's Microsoft 365 tenant policy

Do not partial-deploy this addon. If any of those three are missing, surface the gap and stop.

---

## Failure modes that masquerade as success

These are the production-fire patterns from real deploys. Watch for them.

| Symptom | Real cause | Fast diagnostic |
|---|---|---|
| `/health` returns ok but `/mcp` 502s | `claude-mcp-stdio` crashed (often auth file missing) | `journalctl -u claude-mcp-stdio -n 100` |
| OAuth `/authorize` redirect loops | claude.ai client passed a different `redirect_uri` than DCR registered | Inspect `oauth-state.json` clients[*].redirect_uris |
| `claude.ai` connector "stays connecting" | `WWW-Authenticate` header missing from 401 | `curl -D - .../mcp` and grep the header |
| Funnel URL works for an hour then 5xx | Funnel session expired silently | `tailscale funnel status` — if "off", re-enable |
| Reboot leaves things broken | One unit wasn't `enable`d, only `start`ed | `systemctl is-enabled` on the full five |
| Mobile (iOS) MCP discovery fails | Tailscale Funnel ATS / cert chain on older iOS | Test from another device first; if all fail, check `tailscale cert` |
| All clients work today, none work in 90 days | Forgot to rotate before token expired & forgot to set Tailscale key 90d expiry → expired silently | Calendar reminders. Not optional. |

---

## References — files this skill expects to find

- `vps-bootstrap/docs/vps-claude-code-mcp-sop.md` — the prose SOP (source of truth for *why*)
- `vps-bootstrap/runtime/oauth-proxy.js` — the OAuth 2.1 proxy implementation, pushed to VPS in E2
- `vps-bootstrap/skills/` — six finer-grained skills the SOP composes (`vps-provisioning`, `tunnel-ingress`, `systemd-service-hardening`, `claude-code-headless`, `mcp-bearer-gateway`, `secret-rotation`). Install globally so this skill can lean on them.
- `.env` at repo root — operator's credentials store (gitignored)
- `.env.example` — sanitized template

If `oauth-proxy.js` is missing from `vps-bootstrap/runtime/`, that's a Phase 0 prerequisite failure: stop and surface it.
