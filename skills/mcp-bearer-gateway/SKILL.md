---
name: mcp-bearer-gateway
description: Wrap a local stdio-based MCP server (Claude Code's `claude mcp serve`, Softeria MS365, any `npx`-installed MCP) with an authenticated HTTP transport using `supergateway` or `mcp-proxy`, plus a bearer token in the `Authorization` header. Use this skill whenever the user mentions exposing an MCP server remotely, "MCP over HTTP", connecting claude.ai to a self-hosted MCP, putting a bearer in front of an MCP, "remote MCP", or wants other agents/clients to talk to a stdio MCP they're running. Prefer this skill over hand-rolled Express wrappers anytime auth + JSON-RPC framing for MCP is the goal.
---

# mcp-bearer-gateway

Most MCP servers ship as stdio processes (designed to be spawned by a local Claude Code or Claude Desktop). To use one from claude.ai, another machine, or any HTTP client, you need a thin gateway that:

1. Spawns the stdio MCP as a child process
2. Translates between HTTP/SSE JSON-RPC and stdio JSON-RPC
3. Validates an `Authorization: Bearer <token>` header before forwarding
4. Returns `401` on missing / wrong token, never leaking server frames

This skill picks the right tool for that job and shows the exact config.

## When this applies

- You have an MCP server that runs as `command [args]` and reads/writes JSON-RPC on stdio
- You want a remote client to talk to it
- You're putting it behind a tunnel (see `tunnel-ingress`) and need app-layer auth

## Why a gateway and not raw exposure

stdio MCP servers have no auth, no TLS, no listen port — they assume a parent process they trust. If you bind one directly to a public port (some MCPs ship an experimental HTTP mode), there's no permission boundary: anyone who can reach the port has root-equivalent on that MCP's domain (mail, files, code execution). A gateway is the smallest possible thing that adds the missing boundary.

## The architectural trap to avoid

A natural-looking design is: "use `supergateway --oauth2Bearer …` to do bearer auth, done in one process". This is **wrong** and discovering it mid-deploy costs hours. `supergateway`'s `--oauth2Bearer` flag is **outbound** — it decorates calls supergateway makes *to* the wrapped stdio MCP. It does **not** validate inbound `Authorization` headers from clients. Same for `mcp-proxy`'s analogous flags. These tools are transport bridges, not auth gateways.

The correct shape is **two processes**:

1. A transport bridge on loopback `:8788`, doing only stdio ↔ HTTP. Unauthenticated, but unreachable from the network.
2. A tiny auth proxy on loopback `:8787`, validating bearers and proxying authorized requests to `:8788`. This is what the tunnel forwards to.

Each piece does one thing. The auth boundary lives in exactly one place, with no flag-matrix to misread.

## Pick the auth proxy

| Auth proxy | What it does | When to pick it |
|---|---|---|
| **`runtime/oauth-proxy.js`** (this bundle) | Validates a static bearer **and** issues/validates OAuth 2.1 access tokens — covers both the CLI path and the claude.ai web/mobile path | Anyone who might ever want claude.ai web/mobile access. Strictly additive over bearer-only — the CLI path still works. |
| **A 40-line bearer-only Node proxy** (template below) | Validates a static bearer only | CLI-only deploys, server-to-server, custom agents — when you're certain claude.ai web access will never be needed. |

If unsure, default to `runtime/oauth-proxy.js`. The 40-line proxy is shown below for completeness and for cases where minimum-surface-area genuinely matters.

## Generate the bearer

```bash
openssl rand -hex 32 > ~/.config/<app>/bearer.token
chmod 600 ~/.config/<app>/bearer.token
```

Treat this like any other secret. Store in your password manager. Rotate quarterly (see `secret-rotation`).

## Install supergateway as the transport bridge

```bash
npm install -g supergateway
```

Run it bound to loopback only, in StreamableHTTP mode, on a port the auth proxy will forward to:

```bash
supergateway \
    --stdio "claude mcp serve" \
    --outputTransport streamableHttp \
    --port 8788 \
    --streamableHttpPath /mcp
```

`supergateway` exposes the stdio MCP as plain HTTP on `127.0.0.1:8788` — no auth, but unreachable.

## The 40-line bearer-only auth proxy

If you don't need OAuth, this is the smallest correct boundary in front of supergateway. Save as `bearer-proxy.js` next to where you'll run it:

```javascript
const http = require("http");
const TOKEN = process.env.MCP_BEARER_TOKEN;
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || "8788", 10);
const BIND_PORT = parseInt(process.env.MCP_PORT || "8787", 10);
const BIND_ADDR = process.env.MCP_BIND_ADDR || "127.0.0.1";
if (!TOKEN) { console.error("MCP_BEARER_TOKEN not set"); process.exit(1); }
const expected = `Bearer ${TOKEN}`;
http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, {"content-type": "text/plain"}); return res.end("ok\n");
  }
  if ((req.headers["authorization"] || "") !== expected) {
    res.writeHead(401, {"content-type": "application/json", "www-authenticate": "Bearer"});
    return res.end(JSON.stringify({error: "unauthorized"}));
  }
  const opts = { hostname: "127.0.0.1", port: UPSTREAM_PORT, path: req.url, method: req.method, headers: {...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}`} };
  const up = http.request(opts, upRes => { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); });
  up.on("error", e => { if (!res.headersSent) { res.writeHead(502, {"content-type":"application/json"}); res.end(JSON.stringify({error:"upstream", message:e.message})); } });
  req.pipe(up);
}).listen(BIND_PORT, BIND_ADDR, () => console.log(`bearer-proxy ${BIND_ADDR}:${BIND_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`));
```

Why so small: a bearer check is `header === expected`. Anything more (rate limiting, audit logging, multi-tenant) goes in front of this or in a sidecar — not bolted on, because then you can't audit "what does this proxy actually allow".

## Run as two systemd units

See `systemd-service-hardening` for hardening directives. The two units, both as the service user:

**`claude-mcp-stdio.service`** — the transport bridge:

```ini
EnvironmentFile=/home/<service_user>/.config/<app>/mcp.env
ExecStart=/usr/bin/supergateway --stdio "${MCP_STDIO_CMD}" --outputTransport streamableHttp --port ${UPSTREAM_PORT} --streamableHttpPath /mcp
```

**`claude-mcp-auth.service`** — the auth proxy (depends on the stdio unit):

```ini
Requires=claude-mcp-stdio.service
After=claude-mcp-stdio.service
EnvironmentFile=/home/<service_user>/.config/<app>/mcp.env
ExecStart=/usr/bin/node /home/<service_user>/workspace/mcp-host/bearer-proxy.js
```

Where `mcp.env` (mode `600`) contains:

```
MCP_STDIO_CMD=claude mcp serve
MCP_BIND_ADDR=127.0.0.1
MCP_PORT=8787
UPSTREAM_PORT=8788
MCP_BEARER_TOKEN=...
```

Always bind `127.0.0.1` for both units — the public exposure happens at the tunnel, not here. Binding `0.0.0.0` plus a tunnel is double-exposure and a foot-gun.

## Multiplexing several MCPs

Run one gateway + one systemd unit per MCP, each on a different loopback port, and route by path at the tunnel layer:

| Tunnel path | Local port | What |
|---|---|---|
| `/mcp` | 8787 | `claude mcp serve` |
| `/ms365` | 8788 | Softeria MS365 MCP |
| `/playwright` | 8789 | Playwright MCP |

For Tailscale Funnel use multiple `tailscale serve` rules. For Caddy/Cloudflare use path-based `reverse_proxy`. Each MCP can have its own bearer.

## Client registration

### Claude Code (laptop)

```bash
claude mcp add --transport http remote-mcp \
    https://<public-url>/mcp \
    --header "Authorization: Bearer <token>"
claude mcp list
```

### claude.ai web (and mobile via claude.ai)

claude.ai's custom-connector dialog **only accepts OAuth client ID/secret**. There is no field for a static `Authorization` header. A bearer-only deployment cannot be registered here — see `runtime/oauth-proxy.js` in this bundle for the OAuth layer that does work.

If you only need CLI access, skip this section; the bearer-only path you've just built covers that fully.

### `.mcp.json` in a repo

```json
{
  "mcpServers": {
    "remote-mcp": {
      "type": "http",
      "url": "https://<public-url>/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_MCP_TOKEN}" }
    }
  }
}
```

Never commit the literal token. Use env-var interpolation or commit a `.mcp.json.template`.

## Health check for monitoring

UptimeRobot (or anything) hitting the bearer-protected endpoint:

- URL: `https://<public-url>/mcp`
- Custom header: `Authorization: Bearer <token>`
- Keyword match: `jsonrpc` (the gateway's initialize response contains it)
- Interval: 5 min

If you want an unauthenticated `/health` for the monitor, put a 20-line reverse proxy in front that exposes only `/health` publicly and forwards `/mcp` with the bearer check intact. Most setups don't need this — the keyword probe with auth is enough.

## Verification checklist

- [ ] `curl` without bearer to public URL returns `401` (not `200`, not `500`)
- [ ] `curl` with correct bearer returns a JSON-RPC frame containing `"jsonrpc"`
- [ ] Wrong-bearer token also returns `401`, not a frame
- [ ] systemd unit restarts cleanly after the inner MCP crashes
- [ ] No logging of the bearer in `journalctl` (grep your token; should be 0 hits)
- [ ] Gateway bound to `127.0.0.1`, confirmed by `ss -tlnp`

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `401` even with correct bearer | Trailing newline in `.env` value | Strip — `tr -d '\n' < bearer.token > bearer.token.clean` |
| `502 Bad Gateway` from tunnel | Inner MCP process crashed | `journalctl -u <name>` for stack trace |
| `EADDRINUSE :8787` | Previous supergateway still alive | `pkill -f supergateway` then `systemctl restart` |
| Client gets stream-cut mid-response | Tunnel idle timeout shorter than MCP call | Increase tunnel timeout (Cloudflare) or use SSE transport |
| Bearer leaks in `journalctl` | `--verbose` left on | Remove verbose flag in production |

## Out of scope

- Choosing or installing the tunnel — see `tunnel-ingress`
- Rotation cadence and client fan-out — see `secret-rotation`
- The MCP server itself (Claude Code, Softeria, etc.) — that's its own skill
