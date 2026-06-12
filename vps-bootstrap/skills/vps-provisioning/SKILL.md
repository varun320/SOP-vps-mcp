---
name: vps-provisioning
description: Provider-agnostic base setup for a new Linux VPS — non-root service user, UFW deny-by-default, fail2ban, unattended-upgrades, SSH key-only auth, hostname/UTC, Tailscale join. Use this skill whenever the user mentions setting up a server, VPS, Hostinger/Hetzner/DigitalOcean/Vultr/Linode, "fresh Ubuntu box", "harden my server", initial server hardening, or wants to install anything on a remote Linux machine for the first time — even if they don't explicitly say "provisioning". Prefer this skill over ad-hoc instructions for any greenfield Linux server.
---

# vps-provisioning

Idempotent base setup for any Linux VPS that will run a service exposed over a tunnel. Distilled from the `vps-claude-code-mcp-sop` Phases A and D.

## When this applies

- Fresh Ubuntu 24.04 LTS (or Debian 12) VPS, root SSH access available
- You intend to run one or more long-lived services under systemd
- Public ingress will be via a tunnel (Tailscale Funnel, Cloudflare Tunnel) — not raw ports
- You have at least one SSH public key ready to install

## Decisions to lock before starting

| ID | Decision | Default |
|----|----------|---------|
| service_user | Non-root user that will own services | `claude`, `mcp`, `app` |
| hostname | Stable identity in monitoring + tunnel | descriptive, lowercase |
| timezone | Server clock | `UTC` — convert at display |
| ssh_pubkey | Your laptop's public key | `~/.ssh/id_ed25519.pub` |
| tunnel | Ingress choice | Tailscale (recommended) |

## The procedure

### 1. Update + base packages

```bash
apt update && apt -y upgrade
apt -y install ufw fail2ban curl wget gnupg2 ca-certificates lsb-release \
               apt-transport-https unattended-upgrades jq git build-essential
dpkg-reconfigure -plow unattended-upgrades
```

### 2. Non-root service user

```bash
useradd -m -s /bin/bash <service_user>
mkdir -p /home/<service_user>/.config
chown -R <service_user>:<service_user> /home/<service_user>/.config
chmod 700 /home/<service_user>/.config
loginctl enable-linger <service_user>   # allow user systemd without active login
```

### 3. UFW deny-by-default

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH (closed after tunnel SSH verified)'
ufw --force enable
ufw status verbose
```

Open no other ports. Tunnels route through their own relay infrastructure.

### 4. fail2ban for SSH

```bash
systemctl enable --now fail2ban
fail2ban-client status sshd
```

### 5. SSH key-only

After `ssh-copy-id root@<VPS_IP>` from your laptop:

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
```

### 6. Identity + clock

```bash
hostnamectl set-hostname <hostname>
timedatectl set-timezone UTC
```

### 7. Tailscale (recommended tunnel)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname=<hostname> --accept-routes=false
# approve the machine in https://login.tailscale.com
```

Once `tailscale ssh <service_user>@<hostname>` works from your laptop, close public SSH:

```bash
ufw delete allow 22/tcp
```

## Verification checklist

- [ ] `ufw status` shows no public ingress
- [ ] `fail2ban-client status sshd` is active
- [ ] `ssh root@<VPS_IP>` with password fails; with key succeeds
- [ ] `hostnamectl` shows correct hostname; `timedatectl` shows UTC
- [ ] `tailscale status` shows the machine; tailnet SSH works
- [ ] Public port 22 is closed (after tailnet SSH verified)

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Locked out after closing :22 | Tailnet SSH not actually working | Always test tailnet SSH **before** `ufw delete allow 22/tcp` |
| `fail2ban` not banning | SSH log path wrong on newer Ubuntu | Verify `/var/log/auth.log` exists; or set backend to `systemd` in jail.local |
| Unattended-upgrades not applying | Service masked | `systemctl unmask unattended-upgrades && systemctl enable --now unattended-upgrades` |
| Tailscale Funnel doesn't enable | Tailnet ACL gate | Enable HTTPS + Funnel in https://login.tailscale.com → DNS / Access Controls |

## Out of scope

- Running a specific service — see `systemd-service-hardening` and the service's own skill
- Choosing between Tailscale / Cloudflare / Caddy — see `tunnel-ingress`
- Headless Claude Code install — see `claude-code-headless`
