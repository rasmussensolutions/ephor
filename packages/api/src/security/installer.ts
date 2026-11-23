import { AuthError } from "../auth/store";
import { type DaemonRelease, shellQuote } from "../machines/installer";

export function securityCommand(origin: string, token: string) {
  return `(set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/security/install.sh`)} -o "$f"; if [ "$(id -u)" = 0 ]; then printf '%s\\n' ${shellQuote(token)} | sh "$f"; else sudo -v; printf '%s\\n' ${shellQuote(token)} | sudo sh "$f"; fi)`;
}
export function securityInstaller(origin: string, release: DaemonRelease) {
  if (!origin.startsWith("https://") || release.securityProtocol !== 1)
    throw new AuthError("SECURITY_BUILD_REQUIRED", 409);
  return `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || { echo 'Linux and root are required.' >&2; exit 1; }
systemctl show-environment >/dev/null
case "$(uname -m)" in
 x86_64) arch=x86_64; trivyarch=64bit; expected=${shellQuote(release.x86_64 ?? "")} ;;
 aarch64|arm64) arch=aarch64; trivyarch=ARM64; expected=${shellQuote(release.aarch64 ?? "")} ;;
 *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac
[ -n "$expected" ]
IFS= read -r token
[ "$(printf %s "$token" | wc -c)" -eq 64 ]
case "$token" in *[!a-f0-9]*) exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https' --max-time 300 ${shellQuote(`${origin}/daemon/`)}"ephord-linux-$arch" -o "$tmp/ephord"
printf '%s  %s\\n' "$expected" "$tmp/ephord" | sha256sum --check --status
# Pin the checksum manifest as well as the release version; never execute a remote installer.
base=https://github.com/aquasecurity/trivy/releases/download/v0.76.2
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 300 "$base/trivy_0.76.2_checksums.txt" -o "$tmp/checksums"
printf '%s  %s\\n' 802e4ac1418ed967cd3c4b901f4f71ca00b7363ede67778665a22d9f13f58c83 "$tmp/checksums" | sha256sum --check --status
asset="trivy_0.76.2_Linux-$trivyarch.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 300 "$base/$asset" -o "$tmp/$asset"
(cd "$tmp"; awk -v name="$asset" '$2 == name { print }' checksums > selected-checksum; [ -s selected-checksum ]; sha256sum --check --status selected-checksum)
tar -xzf "$tmp/$asset" -C "$tmp" trivy
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$tmp/trivy" /usr/local/libexec/ephor-trivy.new
mv -f /usr/local/libexec/ephor-trivy.new /usr/local/libexec/ephor-trivy
install -o root -g root -m 0755 "$tmp/ephord" /usr/local/libexec/ephor-security.new
mv -f /usr/local/libexec/ephor-security.new /usr/local/libexec/ephor-security
printf '%s\\n' "$token" | /usr/local/libexec/ephor-security configure-security ${shellQuote(origin)}
cat > /etc/systemd/system/ephor-security.service <<'UNIT'
[Unit]
Description=Ephor security observation and vulnerability scanning
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/libexec/ephor-security security-worker
Restart=on-failure
RestartPreventExitStatus=77
RestartSec=15
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_NET_ADMIN CAP_SYS_PTRACE
ReadWritePaths=/var/lib/ephor-security
InaccessiblePaths=-/var/lib/ephor-protections
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
MemoryMax=1G
CPUQuota=100%
TasksMax=128
Nice=10
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/ephor-security.service
systemctl daemon-reload
systemctl enable ephor-security.service
systemctl restart ephor-security.service
systemctl is-active --quiet ephor-security.service
echo 'Security collection enabled. Findings will appear after the first scan.'
`;
}
