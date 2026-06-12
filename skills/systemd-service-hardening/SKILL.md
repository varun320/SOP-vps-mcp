---
name: systemd-service-hardening
description: Write production-grade systemd unit files for long-running services on Linux — non-root user, sandbox directives (NoNewPrivileges, ProtectSystem, ProtectHome, ReadWritePaths, MemoryDenyWriteExecute), restart policy, EnvironmentFile loading, journald logging. Use this skill whenever the user mentions creating a .service file, "make this survive reboot", "run as a daemon", "background service", systemd, daemonize, or wants to convert a hand-run command into a managed service. Prefer this skill over minimal `[Unit]/[Service]/[Install]` stubs anytime the service handles secrets, listens on a port, or runs as a service user.
---

# systemd-service-hardening

A production-grade systemd unit template plus a reasoning guide for the sandbox directives. The goal: a service that survives reboots, restarts on crash, can't escalate privileges, and writes only where it must.

## When this applies

- You have a binary, npm/pip script, or shell command that needs to be a long-running service
- The host is a Linux VPS or workstation with systemd (Ubuntu, Debian, Fedora, Arch)
- You want one source of truth for the unit, not ad-hoc `nohup ... &` or `screen`

## Why hardening matters

A bare-minimum unit (just `ExecStart` + `User`) runs your service, but if it's compromised the attacker has the same access as that user — including read on `/etc`, write to `/tmp`, the ability to spawn new namespaces, etc. The sandbox directives below cost zero performance and remove most of that lateral surface. Treat them as default, not optional.

## Template

Create `/etc/systemd/system/<name>.service`:

```ini
[Unit]
Description=<short human description>
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<service_user>
Group=<service_user>
WorkingDirectory=/home/<service_user>/<workdir>
EnvironmentFile=/home/<service_user>/.config/<app>/env
ExecStart=<absolute path to binary> <args>
Restart=on-failure
RestartSec=5s

# --- Sandbox ---
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/<service_user>/<workdir>
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
```

Then:

```bash
systemctl daemon-reload
systemctl enable --now <name>
systemctl status <name> --no-pager
journalctl -u <name> -n 50 --no-pager
```

## What each directive does, and when to relax it

| Directive | Effect | Relax when |
|---|---|---|
| `NoNewPrivileges=true` | Process and children can never gain new caps via setuid | Almost never — keep it |
| `PrivateTmp=true` | Service gets its own `/tmp`, `/var/tmp` namespace | Service must share `/tmp` with another process |
| `ProtectSystem=strict` | `/`, `/usr`, `/boot`, `/etc` read-only; `/var`, `/run` writable | Service writes to `/var/lib/<name>` — that's already writable so usually fine |
| `ProtectHome=read-only` | All `/home`, `/root` read-only | Service must write under `/home/<user>` — add `ReadWritePaths=` for the exact path |
| `ReadWritePaths=` | Whitelist of writable paths under the read-only home | Service needs multiple write dirs — list all |
| `ProtectKernelTunables=true` | Block writes to `/sys`, `/proc/sys` | Service tunes kernel params (rare) |
| `ProtectKernelModules=true` | Block `modprobe` | Service loads modules (kernel-level tooling only) |
| `ProtectControlGroups=true` | Block cgroup writes | Service is a container runtime |
| `RestrictNamespaces=true` | Block creating new namespaces | Service runs containers itself |
| `RestrictRealtime=true` | Block realtime scheduling | Audio / robotics workloads |
| `LockPersonality=true` | Pin personality (no `setarch`) | Almost never |
| `MemoryDenyWriteExecute=true` | Pages cannot be both writable + executable | JIT runtimes (some Node native modules, V8 in some modes) — try with it first; remove if `journalctl` shows it killing your process |

## Reading the journal

`journalctl` is the only log source you need for a unit:

```bash
journalctl -u <name>                 # all history
journalctl -u <name> -n 200 --no-pager
journalctl -u <name> -f              # follow
journalctl -u <name> --since "1h ago"
journalctl -u <name> -p err          # errors only
```

Avoid writing log files inside the service — let journald collect stdout/stderr.

## Secrets — three patterns from worst to best

| Pattern | When | Risk |
|---|---|---|
| Hardcoded `Environment=KEY=value` in unit | Never | Unit is world-readable in `/etc/systemd/system/`; secret leaks |
| `EnvironmentFile=/home/<user>/.config/<app>/env` with `chmod 600` | Default — what the template uses | Owner can read; acceptable for solo / small team |
| `LoadCredential=KEY:/run/credstore/<name>` + `ExecStart=... ${CREDENTIALS_DIRECTORY}/KEY` | Hardened / multi-tenant boxes | Credential only visible inside the service's mount namespace |

For the env-file pattern, the file should look like:

```
ANTHROPIC_API_KEY=sk-ant-...
BEARER_TOKEN=...
```

No quotes, no `export`, mode `600`, owned by `<service_user>`.

## Restart policy

| Setting | Effect | Use for |
|---|---|---|
| `Restart=on-failure` | Restart only on non-zero exit / signal | Default — what you want |
| `Restart=always` | Restart even on clean exit | Service should never exit; suspicious if it does |
| `Restart=no` | Never restart | One-shot batch jobs (`Type=oneshot`) |
| `RestartSec=5s` | Wait 5s between restarts | Tune up if upstream rate-limits |

Add `StartLimitBurst=5` + `StartLimitIntervalSec=60` if a crashloop could DoS dependencies.

## Verification checklist

- [ ] `systemctl status <name>` shows `active (running)` after a full `reboot`
- [ ] `journalctl -u <name> --since "5m ago"` is clean (no permission errors from sandbox)
- [ ] Process is owned by `<service_user>`, not root (`ps -ef | grep <name>`)
- [ ] Service is bound only where intended (`ss -tlnp | grep <port>`)
- [ ] Killing the process with `kill -9` triggers an automatic restart within `RestartSec`
- [ ] Env file is `600` and owned by `<service_user>`

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied` writing to a path | `ProtectHome=read-only` or `ProtectSystem=strict` blocking | Add path under `ReadWritePaths=` |
| Process killed with `EPERM` after start | `MemoryDenyWriteExecute` + JIT runtime | Remove that directive |
| Env vars empty inside the service | Wrong path in `EnvironmentFile=` or file mode unreadable to service user | `ls -la` the path; check ownership |
| Restart loop pinning CPU | No `StartLimitBurst` cap | Add the burst + interval limits |
| `Failed to determine user credentials` | `User=` doesn't exist | Create the user (`useradd -m`) before enabling |

## Out of scope

- The application that runs inside the unit — its own skill covers that
- Tunnel / ingress — see `tunnel-ingress`
- Secret rotation cadence — see `secret-rotation`
