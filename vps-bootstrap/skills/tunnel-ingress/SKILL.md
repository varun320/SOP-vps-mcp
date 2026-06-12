---
name: tunnel-ingress
description: Choose and configure the right public-ingress tunnel for a self-hosted service on a Linux VPS — Tailscale Funnel, Cloudflare Tunnel, or Caddy + Let's Encrypt. Use this skill whenever the user mentions exposing a local port to the internet, "how do I get HTTPS on my VPS", reverse proxy, tunneling, ngrok-but-permanent, putting an MCP server / API / dashboard / webhook online, or asks about TLS certs for a homelab/VPS. Prefer this skill over recommending raw nginx+certbot whenever a tunnel would avoid opening public ports.
---

# tunnel-ingress

A chooser plus three concrete recipes for exposing `127.0.0.1:<port>` on a Linux VPS to the public internet with TLS — without inventing fragile glue.

## When this applies

You have a service bound to a loopback port (e.g. `127.0.0.1:8787`) and need:
- Public HTTPS URL
- Authentication or a private overlay
- Survives reboot
- Free auto-renewing certs ideally

## Why a chooser, not a default

Each option has a sharp tradeoff. Picking wrong wastes hours later when you hit the limit you didn't read about.

| Option | Public on internet? | Cost | TLS | Auth | Best for |
|---|---|---|---|---|---|
| **Tailscale Funnel** | Yes (via `*.ts.net`) | Free for small use | Auto-renew | None at edge (add bearer at app) | Solo / small team; minimum moving parts |
| **Cloudflare Tunnel** | Yes (custom domain) | Free | Auto-renew | Cloudflare Access optional | Custom domain wanted; CF account already exists |
| **Caddy + Let's Encrypt** | Yes (custom domain) | Free | Auto-renew | DIY | You must control the certificate / can't use a third-party tunnel |
| **Tailscale (private)** | No | Free | N/A | Tailnet membership | Internal-only services |

## Decision rule

1. Service is **internal-only** → Tailscale without Funnel. Done.
2. Service must be **public** and you don't already own a domain → Tailscale **Funnel** (free `*.ts.net` subdomain).
3. Service must be **public on your own domain** and you have a Cloudflare account → **Cloudflare Tunnel**.
4. You **cannot use a third-party tunnel** (policy, air-gap, regulated env) → **Caddy + Let's Encrypt**, open 80/443.

## Recipe 1 — Tailscale Funnel

Install + join tailnet, enable Funnel in admin console, forward public 443 to local plaintext:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname=<host>
# Then in https://login.tailscale.com → DNS → enable HTTPS,
# Access Controls → Funnel → allow this machine
tailscale funnel --bg --https=443 http://127.0.0.1:<port>
tailscale funnel status
```

Verify: `curl -sS https://<host>.<tailnet>.ts.net/` from your laptop. TLS handshake must succeed.

**Why this is the default**: zero domain admin, zero cert management, zero firewall ports opened on the host. The tradeoff is the URL is `*.ts.net`, which is fine for internal tools but unbranded.

## Recipe 2 — Cloudflare Tunnel

```bash
# install cloudflared (see official docs for your distro)
cloudflared tunnel login
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> <subdomain>.<your-domain>
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: <name>
credentials-file: /etc/cloudflared/<uuid>.json
ingress:
  - hostname: <subdomain>.<your-domain>
    service: http://127.0.0.1:<port>
  - service: http_status:404
```

```bash
cloudflared service install
systemctl enable --now cloudflared
```

**Why pick this over Funnel**: you get a branded URL on your own domain, and optional Cloudflare Access (Zero Trust auth) at the edge.

## Recipe 3 — Caddy + Let's Encrypt

When tunnels aren't an option. Caddy auto-provisions and renews certs.

```bash
apt -y install caddy
ufw allow 80/tcp
ufw allow 443/tcp
```

`/etc/caddy/Caddyfile`:

```
<subdomain>.<your-domain> {
    reverse_proxy 127.0.0.1:<port>
}
```

```bash
systemctl reload caddy
```

DNS A record must already point at the VPS. Cert appears in 30s.

**Why this is third choice**: you open public ports and own cert lifecycle. More attack surface, more to monitor.

## Authentication at the tunnel layer

Tunnels are about reachability, not auth. Most services still need a bearer or session check **at the app**.

| Tunnel | Recommended auth pattern |
|---|---|
| Tailscale Funnel | Bearer in `Authorization` header validated by your app (or by `mcp-bearer-gateway`) |
| Cloudflare Tunnel | Cloudflare Access (Zero Trust) for browser users; bearer for API clients |
| Caddy | `forward_auth` directive or bearer at app |

## Verification checklist

- [ ] `curl -sS https://<public-url>/` returns the expected response from your laptop
- [ ] Service still bound only to `127.0.0.1` (verify with `ss -tlnp`)
- [ ] `ufw status` reflects the actual tunnel choice (no extra open ports)
- [ ] Tunnel restarts cleanly after VPS reboot (`systemctl status tailscaled` / `cloudflared` / `caddy`)
- [ ] TLS cert is valid for at least 30 days (browser padlock or `openssl s_client`)

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Funnel returns 502 | Local service down or wrong port | `curl 127.0.0.1:<port>` first |
| Cloudflare Tunnel "no available origins" | `cloudflared` not running or DNS not yet propagated | `systemctl status cloudflared`; wait + retry |
| Caddy "no such host" | DNS A record missing or wrong | `dig +short <fqdn>` should return VPS IP |
| Cert renewal failing | Caddy can't reach LE / port 80 blocked | Re-open `:80` in UFW; check `journalctl -u caddy` |
| Funnel URL works for owner but not guests | Funnel not yet enabled in admin console | Toggle HTTPS + Funnel in tailnet settings |

## Out of scope

- App-layer auth — see `mcp-bearer-gateway` for the bearer pattern
- systemd unit details for the service behind the tunnel — see `systemd-service-hardening`
- Secret rotation for tunnel auth-keys — see `secret-rotation`
