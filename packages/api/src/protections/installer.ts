import { AuthError } from "../auth/store";
import {
  type DaemonRelease,
  sharedRoleInstaller,
  shellQuote,
} from "../machines/installer";
export function protectionCommand(origin: string, token: string) {
  return `(set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/protections/install.sh`)} -o "$f"; if [ "$(id -u)" = 0 ]; then printf '%s\\n' ${shellQuote(token)} | sh "$f"; else sudo -v; printf '%s\\n' ${shellQuote(token)} | sudo sh "$f"; fi)`;
}
export function protectionInstaller(origin: string, release: DaemonRelease) {
  if (
    !origin.startsWith("https://") ||
    release.protectionProtocol !== 1 ||
    release.managedUpdatesProtocol !== 2
  )
    throw new AuthError("PROTECTION_BUILD_REQUIRED", 409);
  const script = `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || { echo 'Linux and root required.' >&2; exit 1; }
systemctl show-environment >/dev/null
# This explicit enrollment authorizes a separate privileged management service.
# No CrowdSec installation or blocking happens until a reviewed panel job is approved.
command -v dpkg-deb >/dev/null || { echo 'Debian or Ubuntu with dpkg-deb is required.' >&2; exit 1; }
case "$(uname -m)" in
 x86_64) arch=x86_64; expected=${shellQuote(release.x86_64 ?? "")} ;;
 aarch64|arm64) arch=aarch64; expected=${shellQuote(release.aarch64 ?? "")} ;;
 *) exit 1 ;;
esac
[ -n "$expected" ]
IFS= read -r token
[ "$(printf %s "$token" | wc -c)" -eq 64 ]
case "$token" in *[!a-f0-9]*) exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https' --max-time 300 ${shellQuote(`${origin}/daemon/`)}"ephord-linux-$arch" -o "$tmp/ephord"
printf '%s  %s\\n' "$expected" "$tmp/ephord" | sha256sum --check --status
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$tmp/ephord" /usr/local/libexec/ephor-protections.new
mv -f /usr/local/libexec/ephor-protections.new /usr/local/libexec/ephor-protections
systemctl stop ephor-protections.service 2>/dev/null || true
printf '%s\\n' "$token" | /usr/local/libexec/ephor-protections configure-protections ${shellQuote(origin)}
cat > /etc/systemd/system/ephor-protections.service <<'UNIT'
[Unit]
Description=Ephor restricted protection management
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/libexec/ephor-protections protection-worker
ExecStopPost=/usr/local/libexec/ephor-protections protection-reset
Restart=on-failure
RestartPreventExitStatus=77
RestartSec=15
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_NET_ADMIN
ReadWritePaths=/var/lib/ephor-protections
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
MemoryMax=768M
TasksMax=64
[Install]
WantedBy=multi-user.target
UNIT
# Static unit: its contents cannot be supplied by a remote management job.
cat > /etc/systemd/system/ephor-crowdsec.service <<'UNIT'
[Unit]
Description=Ephor managed CrowdSec SSH detection
After=network-online.target
ConditionPathExists=/var/lib/ephor-protections/engine/config.yaml
[Service]
Type=simple
ExecStart=/var/lib/ephor-protections/runtime/usr/bin/crowdsec -c /var/lib/ephor-protections/engine/config.yaml
Restart=on-failure
RestartSec=15
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=CAP_DAC_READ_SEARCH
ReadWritePaths=/var/lib/ephor-protections/engine
InaccessiblePaths=/var/lib/ephor-protections/identity.json /var/lib/ephor-protections/state.json /var/lib/ephor-protections/receipts -/var/lib/ephor-protections/updates.json -/var/lib/ephor-protections/update-request.json -/var/lib/ephor-protections/update-contact.json
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=512M
TasksMax=64
[Install]
WantedBy=multi-user.target
UNIT
# Privilege boundary: only these fixed entry points can apply typed APT policy or a guarded reboot.
# Package maintainer scripts run as root; the control-plane job cannot provide executable content.
cat > /etc/systemd/system/ephor-updates-apply.service <<'UNIT'
[Unit]
Description=Apply reviewed Ephor automatic update policy
ConditionPathExists=/var/lib/ephor-protections/update-request.json
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/ephor-protections protection-updates-apply
TimeoutStartSec=infinity
UMask=0077
UNIT
cat > /etc/systemd/system/ephor-updates-reboot.service <<'UNIT'
[Unit]
Description=Check Ephor authorized automatic reboot window
ConditionPathExists=/var/lib/ephor-protections/updates.json
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/ephor-protections protection-updates-reboot
UMask=0077
UNIT
cat > /etc/systemd/system/ephor-updates-reboot.timer <<'UNIT'
[Unit]
Description=Check Ephor reboot policy once per minute
[Timer]
OnCalendar=*-*-* *:*:00 UTC
AccuracySec=1s
RandomizedDelaySec=0
Persistent=false
[Install]
WantedBy=timers.target
UNIT
chmod 0644 /etc/systemd/system/ephor-updates-apply.service /etc/systemd/system/ephor-updates-reboot.service /etc/systemd/system/ephor-updates-reboot.timer
systemctl daemon-reload
systemctl enable --now ephor-updates-reboot.timer
chmod 0644 /etc/systemd/system/ephor-protections.service /etc/systemd/system/ephor-crowdsec.service
systemctl daemon-reload
systemctl enable ephor-protections.service
systemctl restart ephor-protections.service
systemctl is-active --quiet ephor-protections.service
echo 'Protection management connected. Review protections in Security > Overview > Managed protections.'
`;
  return sharedRoleInstaller(script, release, "protections");
}
