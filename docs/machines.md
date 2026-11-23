# Connecting machines

Ephor's first daemon release enrolls Linux machines and reports CPU usage, memory
usage, and disk usage per mount. It sends a fresh snapshot about every 15 seconds;
the panel considers it offline after 60 seconds without a report. The dashboard
polls every 15 seconds while visible. Offline machines retain their last sample,
clearly labelled as stale. Open a machine’s name or Details link to view its
individual page, with Overview, Services, Storage, and Settings tabs.

## Prepare the panel

1. Apply the new database migration (existing users and passkeys are preserved):

   ```sh
   bun --env-file=apps/server/.env run auth:admin migrate
   # Cloudflare alternative:
   bun run auth:admin migrate --worker --remote
   ```

2. Build the Linux artifacts with Docker/Buildx running, **before** building the
   dashboard. Docker Desktop includes the required architecture emulation:

   ```sh
   bun run bundle:daemon             # x86_64 and aarch64
   # Or only the architecture you use:
   bun run bundle:daemon x86_64
   bun run build
   ```

   This uses the committed Cargo lockfile and creates static musl binaries plus
   `manifest.json` (SHA-256 checksums) in `apps/dashboard/public/daemon/`. These
   generated artifacts are intentionally gitignored. Vite copies them to
   `apps/dashboard/dist/client/daemon/` for deployment. They must be part of the
   deployed assets, including when using Workers, Docker, or Railway. A deployment
   without artifacts still runs the dashboard, but cannot issue installer commands.

   For remote Git-based builds, bundle in your CI/build preparation and include
   these files in the image or uploaded dashboard assets. `bun run build` alone
   does not invoke Docker. Alternatively, the Node/Bun server can serve a prepared
   artifact directory using `EPHOR_DAEMON_DIST=/absolute/path/to/daemon`.
   `deploy/daemon/Dockerfile` also supports Buildx's local output for CI.

3. Serve the dashboard, `/api/*`, and `/daemon/*` at one **public HTTPS origin**.
   Configure `EPHOR_ORIGIN` to exactly that origin, without a trailing slash.
   A normal TLS reverse proxy, Railway HTTPS domain, or Worker domain works.
   Allow outbound HTTPS/DNS on the VPS. No inbound agent port is needed.

Changing the panel hostname also changes the WebAuthn relying party. Existing
localhost passkeys will not authenticate on a different hostname; use the documented
deployment-admin recovery flow to register a passkey on the new origin. Do not
change the origin casually on an existing production installation.

## Add your VPS

Open **Machines → Add machine**, enter a name, and verify your passkey. Copy the
command and run it on the VPS within ten minutes. It needs `sudo`, `curl`,
`sha256sum`, `useradd`, `runuser`, and a running systemd, as on typical Ubuntu/Debian
VPS installations. Currently supported CPUs are x86_64 and aarch64; only bundled
architectures are installable. The command also works directly as root without sudo.

The command downloads the installer to a temporary file. The installer downloads
the binary from **your panel**, verifies the pinned SHA-256 hash, creates the
`ephord` system user, enrolls as that user, and installs/enables `ephord.service`.
It also installs Docker Engine 28+, Buildx, Git, checksummed Railpack, and the
separate `ephor-services.service` deployment worker. Current bundles install only
one `/usr/local/bin/ephord`; these services invoke different modes with their own
credentials and permissions. It installs the checksummed
Trivy scanner and enables `ephor-security.service` with its own credential and
root-owned state directory. Dependency installation is
automatic on Ubuntu and Debian using Docker's official apt repository. Other
Linux distributions need Docker, Buildx, and Git preinstalled. Existing Docker
installations are validated, not replaced; conflicting runtime packages require
manual setup. [Docker installation reference](https://docs.docker.com/engine/install/ubuntu/).

The machine appears as pending, then connecting, then online once its first
sample arrives. Let the command finish: monitoring can appear before deployments
and Security are ready. Machine Maintenance shows one Ephor version, role status and an update policy, and provides
one setup or repair command for the installed helpers. The Security tab shows collector status
and links to that same Maintenance page. A failed helper does not prevent the
other helper from being attempted or remove successful monitoring enrollment.

The enrollment command contains separate monitoring, deployment and Security enrollment secrets. It is shown once, not stored in browser
storage, and may remain in your clipboard or shell history. It expires in ten
minutes, can claim only one machine, and can be cancelled with Disconnect. Closing
the add dialog preserves the command until you leave the page; losing it means
cancelling that pending machine and generating another command.

```sh
sudo systemctl status ephord
sudo journalctl -u ephord --since '10 minutes ago'
```

The agent backs off on network/server failures, uses normal TLS certificate
validation, never follows redirects, and does not inherit HTTP proxy settings.
A revoked/rejected credential stops the agent with exit code 77; systemd does not
restart it in a loop. Fix network errors and it reconnects automatically, or use
`sudo systemctl restart ephord` after correcting local configuration.

## Security boundary

- Browser list/enrollment/revocation routes use the existing owner session and
  origin checks. Issuing/revoking requires a passkey session less than five minutes
  old. The UI explicitly verifies with your passkey for each action.
- Enrollment tokens and machine credentials have 256 bits of OS-generated entropy.
  Only SHA-256 digests are stored on the panel. The daemon generates and persists
  its credential **before** sending it. Enrollment is an atomic SQL claim, portable
  to PostgreSQL and D1. A retry after a lost response is accepted only with the same
  credential and within the original token's lifetime; it cannot claim a second
  machine or change credentials.
- Machine bearer credentials authorize only their own telemetry and fixed update
  polling/reporting routes, never browser routes, arbitrary service actions, or
  other machines. Enrollment uses a separate one-use token. These exact agent
  POST routes accept requests without a browser Origin header. Other browser CSRF protections remain.
- Reports have a 32 KiB body limit, bounded/validated metrics, per-machine rate
  limits, and server-generated last-seen times. Incoming identity fields are ignored;
  the credential determines the machine. Revocation is checked again during writes.
- Credential files are mode 0600 in a private 0700 directory. Neither persistent
  credentials nor enrollment tokens are command-line arguments to the daemon.
  Identity files cannot be silently overwritten by another enrollment.
- The systemd agent runs as `ephord`, without capabilities, with a read-only system,
  private temporary directory and devices, inaccessible home directories, and
  privilege escalation disabled. It collects only host metadata and resource
  metrics. There is no remote shell, arbitrary job execution, or Docker access. The optional
  root updater and deployment worker are separate helpers; monitoring remains unprivileged.
- The installer runs as root to install a service. You trust your panel's TLS
  identity and its published installer/manifest. Checksums detect binary corruption
  or substitution relative to that manifest; this is **not** independent release
  signing or protection against a compromised panel serving both malicious code
  and a matching hash. After this initial trust bootstrap, the optional updater
  independently verifies signed releases against a root-owned pinned key. Updates
  require an explicit panel request and fresh owner authentication by default.
  An owner can instead authorize automatic signed updates when idle, or pin the
  installed version, through Maintenance with a fresh passkey.
- A compromised monitored host can forge its own measurements. Monitoring does not
  provide hardware attestation. A stolen machine credential remains usable until
  revoked; disconnect and re-enroll to replace it.

Enrollment issuance, successful enrollment and revocation appear in security
activity. The latest telemetry snapshot is overwritten per machine; CPU, memory usage, and
root filesystem usage also retain 24 hours of minute samples. Keep normal edge
request limits on public deployments; application limits are not a DDoS service.
The current small-fleet implementation lists all machines and has a soft cap of
1,000 retained machine records, including pending and disconnected records.

## Disconnect, uninstall, or retry a failed installation

Disconnect on the Machines page first. This immediately invalidates its credential
and pending token, while leaving services on the VPS untouched. To remove Ephor
from the VPS (including a partial installation), run:

```sh
sudo systemctl disable --now ephord.service  # May say missing if setup failed early
sudo rm -f /etc/systemd/system/ephord.service /usr/local/bin/ephord
sudo systemctl daemon-reload
sudo userdel ephord                        # May say missing if setup failed early
sudo rm -rf /var/lib/ephord
```

Only run this for the Ephor-created account/files. The installer deliberately refuses
to adopt an existing `ephord` account or overwrite an identity. After cleanup, create
a new enrollment command. If enrollment was interrupted and the token is still
valid, the CLI can retry with the same private config and stdin token, but the full
installer intentionally refuses to reinstall over its partial state.

## Local development and checks

Real VPS enrollment requires public HTTPS. Loopback HTTP is allowed by the Rust
CLI **only for localhost development**; the dashboard never emits an HTTP VPS
installer command. For a deterministic isolated local integration check:

```sh
cargo build --locked -p ephord
EPHOR_DAEMON_TEST_BINARY="$PWD/target/debug/ephord" bun test packages/api/test/machines.test.ts
cargo test --workspace --locked
bun run check:daemon
```

The integration check starts a temporary loopback API with an isolated SQLite
(or `TEST_DATABASE_URL` PostgreSQL schema), enrolls the real daemon, ingests real
metrics, and revokes its credential. It never uses your owner account or machines.
`cargo run -p ephord -- sample` prints one real metrics snapshot without connecting.

Unit/integration tests cover token races, expiry/replay, lost-response retries,
credential isolation, CSRF, stale authentication, revocation during writes,
malformed/oversized telemetry, offline status, rate limits, private identity
persistence, and installer shell syntax/integrity checks. CI also runs the real
agent/API flow on Linux. Installation on your particular VPS/systemd distribution
still needs an operator smoke test.

## Daily development with a stable tunnel

Configure a locally managed named Cloudflare Tunnel once, route a dedicated DNS
hostname to it, and copy `deploy/cloudflare/dev-tunnel.example.yml` to
`deploy/cloudflare/dev-tunnel.yml` with your tunnel ID, credential-file path and
hostname. The machine-specific configuration is gitignored. Set `EPHOR_ORIGIN`
in `apps/server/.env` to that exact HTTPS origin.

Then run from the repository root:

```sh
bun run dev:tunnel
```

This starts the existing `ephor-dev-db` container if stopped, applies migrations,
runs the API with watch mode, runs Vite on loopback port 3000, and connects the named
tunnel. Open the printed HTTPS URL every time. UI edits hot-reload without builds;
API edits restart automatically. Ctrl+C stops the dev processes, leaving the database
container running. Docker Desktop must already be running. Ports 3000 and 3002 must
be free. The landing-page development server is independent (`bun run dev:website`).

Moving from a previous hostname needs one owner recovery and VPS re-enrollment.
Subsequent restarts keep the same hostname, passkeys and machine configuration.
Use this address only for development: Vite serves frontend source and debugging
modules publicly through the tunnel. Server secrets remain outside frontend code.

### IP addresses

Updated agents report up to 64 local interface addresses, excluding loopback,
unspecified and multicast addresses. The table prefers a public IPv4 address and
then a public IPv6 address; the machine Overview lists reported addresses and hostname.
Older agents remain compatible and show “IP unavailable” until upgraded. For a
host behind NAT without a public interface address, Ephor does not guess its public
IP or contact third-party IP lookup services. Interface reporting is not proof of
reachability or an SSH address.

If a current daemon reports no addresses, older installations may have a systemd
socket allowlist that excludes `AF_NETLINK`. Linux uses that socket family to read
interface addresses. Binary updates preserve the installed service configuration.
Apply this once on the VPS to correct the monitoring service, keeping it
unprivileged with no capabilities:

```sh
sudo mkdir -p /etc/systemd/system/ephord.service.d
sudo tee /etc/systemd/system/ephord.service.d/10-interface-addresses.conf >/dev/null <<'EOF'
[Service]
RestrictAddressFamilies=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
EOF
sudo systemctl daemon-reload
sudo systemctl restart ephord
```

Allow about 30 seconds for the next report and dashboard refresh. New installations
already include this setting. The separate privileged updater does not need it.

To upgrade an existing agent, download the newly built binary from your panel's
`/daemon/ephord-linux-x86_64` (or aarch64) endpoint, verify its SHA-256 against the
panel's `/daemon/manifest.json`, stop `ephord`, replace `/usr/local/bin/ephord` with
root ownership and mode 0755, and start `ephord` again. Preserve
`/var/lib/ephord/identity.json`; no new enrollment is needed for a binary upgrade.

## Provider detection

Daemon 0.1.2 adds automatic detection for Hetzner Cloud, AWS, Google Cloud, Azure,
DigitalOcean and Linode. The Machines table shows the provider; **machine page → Settings → Provider**
shows detected region/zone and lets the owner choose **Set manually** and enter a
provider name (including netcup or a custom name). Save the change, or choose
**Automatic** and save to clear the override. Manual choices persist independently
of agent reports. No provider account API key is required.

Detection runs in a background worker, so unavailable metadata does not delay
monitoring. Successful results are cached until daemon restart; failures retry
every 15 minutes. Known container environments are skipped. Unsupported providers,
disabled metadata and older daemons remain usable with a manual label.

The daemon queries only fixed paths at `169.254.169.254`, with 600 ms request
timeouts, no redirects/proxies and a 16 KiB response limit. AWS uses IMDSv2 and
Linode uses its metadata token protocol. Only provider, region and zone are sent
to the panel; user-data and cloud credentials are never requested. These labels
are informational, not trusted identity or authorization evidence. Manual edits
require the signed-in owner and same-origin JSON requests, and are audited.

Apply migration `0004_machine_provider.sql` before starting an updated panel
(`bun --env-file=apps/server/.env run auth:admin migrate`; for D1 use the worker
migration command above). `bun run dev:tunnel` applies migrations automatically.
Existing VPSs need the new daemon release for detection; manual overrides work
with older daemons too.

Metadata references: [Hetzner](https://docs.hetzner.cloud/reference/cloud#server-metadata),
[AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html),
[Google Cloud](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata),
[Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/instance-metadata-service),
[DigitalOcean](https://docs.digitalocean.com/products/droplets/how-to/access-metadata/),
[Linode](https://techdocs.akamai.com/cloud-computing/docs/metadata-service-api).

## Unified machine maintenance

See [Machine maintenance](updates.md) to configure signed releases and enable passkey-confirmed updates of all installed components. Existing installations run the single setup or repair command from their Maintenance tab once.

## Machine detail pages and history

Select a machine name or **Details** in Machines to open `/machines/<id>`.

- **Overview** shows the latest CPU, memory, root disk and host uptime, resource
  charts, capacity insights, host metadata and interface addresses.
- **Services** lists only services assigned to this machine, with links to their
  detail pages and the deployment worker’s connection status.
- **Storage** shows used and free space for every reported filesystem. Mounts can
  share a physical disk, so their totals are not added together.
- **Maintenance** manages updates, setup and repair for all five Ephor components.
- **Settings** preserves provider overrides.
  Updating or disconnecting still requires fresh passkey authentication.

Apply `0012_machine_metrics.sql` before starting the updated panel:

```sh
bun --env-file=apps/server/.env run auth:admin migrate
# Cloudflare D1:
bun run auth:admin migrate --worker --remote
```

History starts with incoming reports after migration; there is no backfill and no
new daemon version is required. The panel keeps the latest report per minute for
24 hours. Charts default to 24h and also offer 15m, 1h and 6h. Six-hour views average
two-minute buckets and 24-hour views average five-minute buckets. Missing buckets
remain gaps, and an unreported root filesystem remains unavailable rather than
zero. All timestamps are assigned by the panel. Network throughput is not collected
by the monitoring daemon and is not included in machine charts.

Machine details poll every 15 seconds and history every 30 seconds while the page
is visible. Offline or disconnected machines retain their latest readings with a
stale label. Capacity insights describe the last sample, not a sustained-load
forecast. History expires through the server’s five-minute cleanup or the existing
Worker cron, even when machines stop reporting.

## Deployment enrollment grants

Migration `0018_machine_deployment_enrollment.sql` adds a hashed deployment grant
to the pending machine. Enrollment issues independent monitoring and deployment
tokens with the same ten-minute expiry. Regenerating or cancelling enrollment
invalidates both. The worker can claim its grant only after monitoring enrollment
activates the machine; monitoring credentials cannot claim it. Owner-issued repair
grants take precedence over the original bootstrap grant. Apply this migration to
PostgreSQL or D1 before running the updated API.

## Automatic Security enrollment

Migration `0021_machine_security_enrollment.sql` adds an independent hashed
Security grant to initial enrollment. New commands include three tickets with
the same ten-minute expiry. The Security ticket becomes claimable only after
monitoring activates the machine. It cannot be used for monitoring or deployments.
The collector still uses `ephor-security.service` and its own credentials under
`/var/lib/ephor-security`; monitoring stays unprivileged. Explicit collector repair
or revocation supersedes the initial grant. Regenerate any pending command issued
before this change. Already enrolled machines can enable Security from their
Security tab. See [Security](security.md) for collection scope and repair details.
