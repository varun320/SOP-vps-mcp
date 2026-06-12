---
name: secret-rotation
description: Rotate long-lived secrets — bearer tokens, tunnel auth-keys, API keys, OAuth client secrets — on a defined cadence, with a written rotation log and a fan-out checklist for every client that holds the old value. Use this skill whenever the user mentions rotating credentials, quarterly key rotation, "we should change the bearer", suspected token leak, "this secret has been around forever", offboarding someone with shared keys, or wants a process for secret hygiene on a self-hosted setup. Prefer this skill over ad-hoc "just regenerate it" anytime more than one client holds the same secret.
---

# secret-rotation

A small, written process for changing long-lived secrets without breaking the things that depend on them. Designed for solo operators and small teams running self-hosted services where there's no Vault / Doppler / AWS Secrets Manager.

## When this applies

- You have a bearer token, API key, OAuth client secret, or tunnel auth-key in production
- More than one client holds the same value (laptop + claude.ai + a `.mcp.json` + a monitor)
- "Just regenerate it" silently breaks something every time

## Why a process beats vibes

Rotation only fails in one of three ways: you forget to update a client, you lose the new secret before saving it, or you can't tell whether the rotation is even working. A two-page log fixes all three. The cost is ten minutes; the saving is the next 3am incident you don't have.

## The cadence

| Secret class | Default cadence | Trigger an off-cycle rotation when |
|---|---|---|
| App bearer tokens | Quarterly (every 90 days) | Someone with access leaves; suspected leak; client device lost |
| Anthropic API keys | Quarterly | Same |
| Tunnel auth-keys (Tailscale, Cloudflare) | Quarterly | Same |
| OAuth client secrets | Annually | Same; or when vendor mandates |
| Token caches (OAuth refresh tokens, MS365) | When they expire (vendor-controlled) | Always — these expire on their own schedule |

Put quarterly rotation on a real calendar with a reminder. The "every 90 days" failure mode is forgetting.

## The rotation log

One file per service, kept next to the env file (mode `600`, owned by `<service_user>`).

`~/.config/<app>/rotation.log`:

```
2026-06-12  bearer       rotated  rotated_by=maaz  reason=quarterly  clients_updated=[laptop, claude.ai, uptimerobot]
2026-09-12  bearer       rotated  rotated_by=maaz  reason=quarterly  clients_updated=[laptop, claude.ai, uptimerobot, .mcp.json]
2026-09-12  ts_authkey   rotated  rotated_by=maaz  reason=quarterly  clients_updated=[vps]
```

Cheap, greppable, survives editor crashes. Don't overthink the format.

## The procedure (works for any secret)

### 1. Inventory every place the old value lives

Before generating anything new, list every client. Miss one and rotation breaks production at the slowest possible moment.

For an MCP bearer, the typical list is:

- [ ] Service env file on the VPS (`~/.config/<app>/env`)
- [ ] Laptop `claude mcp` registration (`claude mcp list` to see)
- [ ] claude.ai custom connector
- [ ] Any `.mcp.json` in repos
- [ ] UptimeRobot / monitor probe headers
- [ ] Password manager entry
- [ ] Any teammate's local config

Write the list down before continuing. This list is the rotation checklist.

### 2. Generate the new value

```bash
openssl rand -hex 32 > ~/.config/<app>/bearer.token.new
chmod 600 ~/.config/<app>/bearer.token.new
```

Save it to the password manager **before** anything else. If your shell dies in the next minute, you don't want the new value to exist only in a file on the server.

### 3. Stage the new value alongside the old

Many gateways support multiple valid bearers at once. If yours does (e.g. a list in env), add the new one without removing the old:

```
BEARER_TOKENS=<old>,<new>
```

If your gateway only accepts a single bearer (the default `supergateway --bearer` does), you'll need a brief window of overlap by deploying the new bearer + updating all clients within a few minutes. Plan around the monitor's probe interval — pause it first.

### 4. Roll the service

```bash
mv ~/.config/<app>/bearer.token ~/.config/<app>/bearer.token.old
mv ~/.config/<app>/bearer.token.new ~/.config/<app>/bearer.token
# update env file or supergateway args to reference the new value
sudo systemctl restart <app>
journalctl -u <app> -n 20 --no-pager
```

### 5. Walk the inventory and update every client

Tick each box from step 1. Don't skip the monitor — a green probe is your confirmation step.

### 6. Verify

- Monitor turns green within one probe interval
- `curl` to the public URL with the **new** bearer returns a valid frame
- `curl` with the **old** bearer returns `401` (proves the old value is truly invalid)
- Smoke-test from each updated client

### 7. Destroy the old value

```bash
shred -u ~/.config/<app>/bearer.token.old
```

Delete the old password manager entry. Append to `rotation.log`.

## Things to plan for once, not every rotation

| Concern | Setup once | Pays off every rotation |
|---|---|---|
| Monitor pause/resume | Bookmark the UptimeRobot pause URL | No false-alarm pages during the window |
| Client inventory | Keep `clients.md` next to `rotation.log` | Step 1 becomes copy-paste |
| Password manager structure | Folder per service, one entry per secret with attached file | New value is saved in 5 seconds |
| Bearer staging support | Pick a gateway that accepts a list of bearers | Eliminates the "brief window" risk |

## Suspected-leak rotation (off-cycle)

Same steps, but with one addition: after step 7, scan logs for use of the old value:

```bash
# example: nginx-style access log on a tunnel
grep -i "bearer <first-8-chars-of-old>" /var/log/...
journalctl -u <app> | grep "<first-8-chars-of-old>"
```

If you see the old bearer used after the rotation timestamp, find the lingering client and update or revoke its access. Note the incident in the log.

## Verification checklist

- [ ] Rotation log has a new entry with today's date, reason, and clients-updated list
- [ ] Monitor was green within one probe interval after rotation
- [ ] Old value returns `401` on a deliberate test
- [ ] Password manager has only the new value (no orphan old entry)
- [ ] Every client from the inventory was actually touched (not just "I think it's fine")

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Rotation breaks something three days later | Missed a client during fan-out | Always work from a written inventory, not memory |
| "It was working, now I can't find the new token" | Saved to file but not password manager | Save to PM **before** mutating the service |
| Old bearer still accepted after restart | Service didn't reload env file | Confirm `systemctl restart` (not just reload); check unit picks up `EnvironmentFile=` |
| Monitor pages during the window | Forgot to pause | Pause **before** step 4, resume after step 6 |
| Same bearer ends up in many repos' `.mcp.json` | No env-var interpolation | Always use `"Bearer ${VAR_NAME}"` and a local env, not the literal value |

## Out of scope

- Generating the bearer in the first place — see `mcp-bearer-gateway`
- Tunnel-key rotation specifics for a chosen tunnel — see `tunnel-ingress`
- Anthropic API key rotation policy — vendor-controlled; follow console.anthropic.com guidance
