import { AuthError } from "../auth/store";
import {
  type DaemonRelease,
  sharedRoleInstaller,
  shellQuote,
} from "../machines/installer";
import { deploymentDependencies } from "./dependencies";
export function serviceCommand(origin: string, token: string) {
  return `(set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/services/install.sh`)} -o "$f"; if [ "$(id -u)" = 0 ]; then printf '%s\\n' ${shellQuote(token)} | sh "$f"; else sudo -v; printf '%s\\n' ${shellQuote(token)} | sudo sh "$f"; fi)`;
}
export function serviceInstaller(origin: string, release: DaemonRelease) {
  if (
    !origin.startsWith("https://") ||
    !release.serviceProtocol ||
    release.serviceProtocol < 2
  )
    throw new AuthError("SERVICE_BUILD_REQUIRED", 409);
  const script = `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || { echo 'Linux and root are required.' >&2; exit 1; }
systemctl show-environment >/dev/null
case "$(uname -m)" in
 x86_64) arch=x86_64; railarch=x86_64; railhash=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb; expected=${shellQuote(release.x86_64 ?? "")} ;;
 aarch64|arm64) arch=aarch64; railarch=arm64; railhash=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9; expected=${shellQuote(release.aarch64 ?? "")} ;;
 *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac
[ -n "$expected" ]
IFS= read -r token
[ "$(printf %s "$token" | wc -c)" -eq 64 ]
case "$token" in *[!a-f0-9]*) exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
${deploymentDependencies()}
curl --fail --silent --show-error --proto '=https' --max-time 300 ${shellQuote(`${origin}/daemon/`)}"ephord-linux-$arch" -o "$tmp/ephord"
printf '%s  %s\\n' "$expected" "$tmp/ephord" | sha256sum --check --status
install -d -o root -g root -m 0755 /usr/local/libexec
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 300 "https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-$railarch-unknown-linux-musl.tar.gz" -o "$tmp/railpack.tgz"
printf '%s  %s\\n' "$railhash" "$tmp/railpack.tgz" | sha256sum --check --status
tar -xzf "$tmp/railpack.tgz" -C "$tmp" railpack
install -o root -g root -m 0755 "$tmp/railpack" /usr/local/libexec/ephor-railpack
install -o root -g root -m 0755 "$tmp/ephord" /usr/local/libexec/ephor-services.new
mv -f /usr/local/libexec/ephor-services.new /usr/local/libexec/ephor-services
printf '%s\\n' "$token" | /usr/local/libexec/ephor-services configure-services ${shellQuote(origin)}
cat > /etc/systemd/system/ephor-services.service <<'UNIT'
[Unit]
Description=Ephor service deployment worker
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
[Service]
Type=simple
ExecStart=/usr/local/libexec/ephor-services service-worker
Restart=on-failure
RestartSec=10
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
CapabilityBoundingSet=
ReadWritePaths=/var/lib/ephor-services
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/ephor-services.service
systemctl daemon-reload
systemctl enable ephor-services.service
systemctl restart ephor-services.service
systemctl is-active --quiet ephor-services.service
echo 'Service worker enabled. Ports 80 and 443 must be free for custom domains. Existing services keep running if the panel is offline.'
`;
  return sharedRoleInstaller(script, release, "services");
}
