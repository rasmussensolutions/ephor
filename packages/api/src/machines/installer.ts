import { AuthError } from "../auth/store";
import { deploymentDependencies } from "../services/dependencies";
import { HEX_KEY } from "./releases";

export interface DaemonRelease {
  serviceProtocol?: 1 | 2 | 3 | 4 | 5;
  updaterProtocol?: 1;
  x86_64?: string;
  aarch64?: string;
}
export function releaseManifest(value: unknown): DaemonRelease {
  if (!value || typeof value !== "object")
    throw new AuthError("DAEMON_NOT_AVAILABLE", 503);
  const manifest = value as Record<string, unknown>;
  const result: DaemonRelease = {};
  for (const arch of ["x86_64", "aarch64"] as const) {
    const digest = manifest[arch];
    if (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
      result[arch] = digest;
  }
  if (!result.x86_64 && !result.aarch64)
    throw new AuthError("DAEMON_NOT_AVAILABLE", 503);
  if (manifest.updaterProtocol === 1) result.updaterProtocol = 1;
  if (
    manifest.serviceProtocol === 1 ||
    manifest.serviceProtocol === 2 ||
    manifest.serviceProtocol === 3 ||
    manifest.serviceProtocol === 4 ||
    manifest.serviceProtocol === 5
  )
    result.serviceProtocol = manifest.serviceProtocol;
  return result;
}
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function installCommand(
  origin: string,
  token: string,
  workerToken: string,
) {
  // sudo authenticates before the pipe, so it cannot consume the enrollment token as a password.
  return String.raw`(set -eu; installer=$(mktemp); trap 'rm -f "$installer"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/install.sh`)} -o "$installer"; token=${shellQuote(token)}; worker_token=${shellQuote(workerToken)}; if [ "$(id -u)" = 0 ]; then printf '%s\n' "$token" "$worker_token" | sh "$installer"; else sudo -v; printf '%s\n' "$token" "$worker_token" | sudo sh "$installer"; fi)`;
}

export function installer(
  origin: string,
  release: DaemonRelease,
  publicKey?: string,
) {
  if (!origin.startsWith("https://"))
    throw new AuthError("HTTPS_REQUIRED", 409);
  return `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo 'Run this installer through sudo.' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'Linux is required.' >&2; exit 1; }
for cmd in curl sha256sum systemctl useradd runuser; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done
systemctl show-environment >/dev/null || { echo 'A running systemd is required.' >&2; exit 1; }
[ ! -e /etc/systemd/system/ephord.service ] && [ ! -e /var/lib/ephord/identity.json ] && [ ! -e /usr/local/bin/ephord ] || {
  echo 'Ephor is already installed. Revoke the old machine and follow the documented reinstall procedure.' >&2; exit 1;
}
case "$(uname -m)" in
  x86_64) arch=x86_64; expected=${shellQuote(release.x86_64 ?? "")} ;;
  aarch64|arm64) arch=aarch64; expected=${shellQuote(release.aarch64 ?? "")} ;;
  *) echo 'Only x86_64 and aarch64 are supported.' >&2; exit 1 ;;
esac
[ -n "$expected" ] || { echo 'This panel has no daemon build for your CPU architecture.' >&2; exit 1; }
IFS= read -r token
[ "$(printf %s "$token" | wc -c)" -eq 64 ] || { echo 'Invalid enrollment token.' >&2; exit 1; }
case "$token" in *[!a-f0-9]*) echo 'Invalid enrollment token.' >&2; exit 1 ;; esac
IFS= read -r worker_token || { echo 'Generate a new enrollment command in Ephor.' >&2; exit 1; }
[ "$(printf %s "$worker_token" | wc -c)" -eq 64 ] || { echo 'Invalid deployment enrollment token.' >&2; exit 1; }
case "$worker_token" in *[!a-f0-9]*) echo 'Invalid deployment enrollment token.' >&2; exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 300 ${shellQuote(`${origin}/daemon/`)}"ephord-linux-$arch" -o "$tmp/ephord"
printf '%s  %s\n' "$expected" "$tmp/ephord" | sha256sum --check --status || { echo 'Daemon checksum verification failed.' >&2; exit 1; }
# Refuse to adopt a pre-existing account; its ownership and privileges are unknown.
if id ephord >/dev/null 2>&1; then
  echo 'The ephord account already exists. Follow the documented reinstall procedure.' >&2; exit 1
fi
curl --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 300 ${shellQuote(`${origin}/api/agent/services/install.sh`)} -o "$tmp/services.sh"
${deploymentDependencies()}
useradd --system --user-group --home-dir /var/lib/ephord --shell /usr/sbin/nologin ephord
install -d -o ephord -g ephord -m 0700 /var/lib/ephord
install -o root -g root -m 0755 "$tmp/ephord" /usr/local/bin/ephord
printf '%s\n' "$token" | runuser -u ephord -- /usr/local/bin/ephord enroll --panel ${shellQuote(origin)} --config /var/lib/ephord/identity.json
unset token
cat > /etc/systemd/system/ephord.service <<'UNIT'
[Unit]
Description=Ephor machine monitoring agent
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=ephord
Group=ephord
ExecStart=/usr/local/bin/ephord run --config /var/lib/ephord/identity.json
Restart=on-failure
RestartSec=15
RestartPreventExitStatus=77
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=
# getifaddrs uses netlink to read local interface addresses on Linux.
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/ephord.service
systemctl daemon-reload
systemctl enable --now ephord.service
if ! printf '%s\\n' "$worker_token" | sh "$tmp/services.sh"; then
  echo 'Monitoring connected, but deployment setup failed. Open this machine’s Settings in Ephor and get a deployment repair command.' >&2
  exit 1
fi
unset worker_token
${publicKey && release.updaterProtocol === 1 ? updaterSetup(origin, publicKey, "/usr/local/bin/ephord") : ""}
echo 'Ephor connected and ready for deployments. Metrics will appear shortly.'
`;
}

// Initial trust is provisioned by an explicit administrator action on the VPS.
export function updaterCommand(origin: string) {
  return `(set -eu; installer=$(mktemp); trap 'rm -f "$installer"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/updater.sh`)} -o "$installer"; if [ "$(id -u)" = 0 ]; then sh "$installer"; else sudo sh "$installer"; fi)`;
}
function updaterSetup(origin: string, key: string, source: string) {
  if (!HEX_KEY.test(key)) throw new AuthError("UPDATES_NOT_CONFIGURED", 503);
  return `
[ ! -e /etc/ephor/updater.json ] || { echo 'Updater already configured. Trust changes require local administration.' >&2; exit 1; }
version=$(runuser -u ephord -- /usr/local/bin/ephord --version)
version="\${version#ephord }"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 ${source} /usr/local/libexec/ephor-updater
/usr/local/libexec/ephor-updater configure-updater ${shellQuote(key)} ${shellQuote(origin)} "$version"
cat > /etc/systemd/system/ephor-updater.service <<'UNIT'
[Unit]
Description=Ephor signed daemon updater
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
User=root
ExecStart=/usr/local/libexec/ephor-updater update-worker
TimeoutStartSec=12min
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/usr/local/bin /var/lib/ephor-updater
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UNIT
cat > /etc/systemd/system/ephor-updater.timer <<'UNIT'
[Unit]
Description=Check for owner-approved Ephor updates
[Timer]
OnBootSec=30s
OnUnitInactiveSec=30s
RandomizedDelaySec=5s
AccuracySec=1s
[Install]
WantedBy=timers.target
UNIT
chmod 0644 /etc/systemd/system/ephor-updater.service /etc/systemd/system/ephor-updater.timer
systemctl daemon-reload
systemctl enable --now ephor-updater.timer
systemctl start --no-block ephor-updater.service
`;
}
export function updaterInstaller(
  origin: string,
  release: DaemonRelease,
  key?: string,
) {
  if (!origin.startsWith("https://") || !key || release.updaterProtocol !== 1)
    throw new AuthError("UPDATER_NOT_AVAILABLE", 503);
  return `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || { echo 'Linux and root are required.' >&2; exit 1; }
[ -f /var/lib/ephord/identity.json ] && [ -f /etc/systemd/system/ephord.service ] || { echo 'Enroll this machine first.' >&2; exit 1; }
[ ! -e /etc/ephor/updater.json ] || { echo 'Updater already configured.' >&2; exit 1; }
systemctl show-environment >/dev/null
case "$(uname -m)" in
  x86_64) arch=x86_64; expected=${shellQuote(release.x86_64 ?? "")} ;;
  aarch64|arm64) arch=aarch64; expected=${shellQuote(release.aarch64 ?? "")} ;;
  *) exit 1 ;;
esac
[ -n "$expected" ] || { echo 'No updater build for this architecture.' >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 300 ${shellQuote(`${origin}/daemon/`)}"ephord-linux-$arch" -o "$tmp/ephord"
printf '%s  %s\\n' "$expected" "$tmp/ephord" | sha256sum --check --status
${updaterSetup(origin, key, '"$tmp/ephord"')}
echo 'Updater enabled. Return to Machines to install the latest signed daemon release.'
`;
}
