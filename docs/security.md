# Security

Security is available from the sidebar and as a tab on each machine and service. The first release provides observation, vulnerability scanning, finding review, and a unified audit timeline. It does not install threat-detection products, change firewall/SSH rules, stop containers, or automatically remediate findings.

## Overview and deployment details

The main Security page opens with layered coverage cards, an architecture diagram, recommendations and recent activity. The **Managed protections** card opens layered, machine-scoped dialogs for CrowdSec and unattended-upgrades. There is no separate Protections tab. Machine and service Security tabs keep their scoped findings view.

Apply migration `0023_security_deployment.sql` for the deployment details record. The server adapter identifies Bun/Node or Cloudflare Workers and its database backend. The configured panel origin is displayed separately. Provider, ingress, separate frontend hosting and an optional enrolled host association are administrator declarations, not network discovery or proof of protection. Editing these details requires a fresh owner passkey session, checks for concurrent edits and writes an audit event. Recording metadata does not change network routes, firewall rules or hosting.

The diagram separates administrator login, machine-initiated outbound HTTPS with jobs returned in responses, and configured public service traffic. A configured service domain does not establish external reachability or valid TLS. Tailscale remains optional. Cloudflare proxy/tunnel declarations do not turn a Bun/Node deployment into a Worker.

### Automatic update recommendations

On Ubuntu/Debian, the collector observes `unattended-upgrades`, effective APT periodic policy and origin rules, standard systemd timer activity, the latest upgrade service result, the APT successful-run timestamp and automatic reboot policy. It does not install packages, refresh repositories, enable updates or reboot. Only bounded, normalized evidence is uploaded; raw APT configuration, which may contain proxy credentials, is excluded.

Installed, configured and recently successful are separate states. A configured origin list does not prove full security repository coverage, and a successful scheduler run does not prove every patch was applied. Custom schedulers and unknown intervals require local review. Host package updates do not update container images. Review service restarts, held packages and reboot windows before changing update policy.

Rebuild and publish the daemon artifacts, then use **Repair helper** on existing machines to receive the new checks. Machines running older helpers show automatic updates as unassessed. After repair, use **Scan now** or wait for the next host scan. Stale collection and incomplete scans never count as confirmed update coverage.

## Enable collection

1. Apply migrations `0020_security.sql` and `0021_machine_security_enrollment.sql` using the normal deployment migration process (both PostgreSQL and SQLite/D1 are supported).
2. Build the Linux daemon artifacts from this source with `bun run bundle:daemon` before building/deploying the dashboard. The generated distribution manifest must contain `securityProtocol: 1`. Both `x86_64` and `aarch64` are supported. The panel intentionally refuses to offer an installer for older binaries.
3. New machine enrollment automatically installs and enables Security alongside monitoring and deployments. Use the normal **Machines → Add machine** command. For an existing machine or interrupted Security setup, open its Security tab, verify your passkey, and choose **Enable collection** or **Repair helper**. Both paths require Linux, systemd, root access, and outbound HTTPS to the panel and scanner databases.
4. Wait for the first scan. **Scan now** queues a fresh scan; results, missing checks, and stale collection are visible in Coverage.

The installer pins Ephor's binary checksum and Trivy 0.76.2, including the SHA-256 of its checksum manifest. Trivy is installed as `/usr/local/libexec/ephor-trivy`; the dedicated collector is `/usr/local/libexec/ephor-security`. Re-run **Repair helper** after publishing updated binaries to update these installations. This helper is separate from the monitoring daemon and deployment worker; the existing monitoring updater does not update it.

Cloudflare template builds currently download the previously published daemon release via `scripts/download-daemon.ts`. Before shipping this feature through that template, publish the new daemon release and update that script's release URL and immutable manifest hash. Do not add `securityProtocol` to an old binary's manifest. Custom panel builds can bundle the new binaries directly.

## What is collected

| Layer            | First-release coverage                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel            | Existing passkeys, sessions and recovery status; authenticated panel actions and account audit events. Sensitive changes still require fresh passkey verification.                                                                                                                                                                                |
| Machine          | Default effective SSH authentication configuration; structured SSH login outcomes; IPv4/IPv6 TCP/UDP listeners and process names; firewall rule evidence; Ubuntu/Debian standard support, local APT security update metadata and reboot marker.                                                                                                   |
| Protection tools | Observed systemd process state for CrowdSec, its firewall bouncer, Fail2ban, Tailscale, Tetragon and Falco. Tailscale backend state where available. These observations do not establish enforcement, inspect tailnet policy or ingest runtime alerts.                                                                                            |
| Service          | Each discovered running Ephor container, including catalog components: immutable local image ID, runtime isolation settings, bind-mount destinations, published ports and networks. Trivy scans OS and language packages for known vulnerabilities and reports advisory, package, installed/fixed version, severity and image/component identity. |

Trivy supplies the vulnerability intelligence. Ephor does not independently synchronize OSV/NVD, inspect source code, prove exploitability, or detect application logic vulnerabilities. Public bind addresses and configured domains are exposure evidence, not an external reachability test. Host SSH checks inspect defaults; `Match` blocks require review. OS lifecycle uses the installed `distro-info-data` catalogue; extended support entitlements are not assessed. Rules containing comments are explicitly redacted for local review. Missing tools, incomplete inventories, stale databases and output limits are reported as incomplete coverage.

## Scheduling and findings

- The helper polls every 30 seconds, runs host checks hourly, and schedules service image scans daily and after the current deployment changes. Manual scans bypass the normalized image-result cache. Partial/failed scans retry after 15 minutes; abandoned jobs expire after 20 minutes. Only one scan per machine runs at a time.
- Image results are cached by immutable image ID for 24 hours. A complete scan requires database metadata newer than 48 hours and stable container inventory. Results from a changed deployment are superseded.
- Findings are deduplicated across retries. Open and acknowledged findings need attention. Accepting risk requires a reason and can have an expiry; expired acceptance returns to open. Findings resolve only when a subsequent check passes, or a complete image scan verifies the old vulnerability is absent. Failed/missing checks do not resolve findings.
- New/reopened high or critical findings use a single installation-wide digest, at most once every 24 hours. Completed/partial scans settle for five minutes before inclusion; unfinished scans are excluded. Further findings wait for the next digest, and unchanged scans do not repeat alerts. Stopped services and disconnected machines are excluded from the digest. In-app and email preferences remain independent. Helpers silent for 30 minutes retain their separate coverage alerts, limited to one per day per last-seen timestamp.

### Grouped maintenance actions

Findings opens in **Grouped actions**, one row per affected service or machine. Counts distinguish finding instances from distinct package advisories, OS packages from language packages and other artifacts, and reported fixed versions from findings without a reported fix. Group counts cover all matching findings, not just the first individual page. Search and resource pagination are applied server-side. **View findings** opens the scoped, paginated evidence list; original severities, review states, and audit history remain available.

Language-package detection does not establish whether a dependency belongs to application code or bundled tooling. Layer labels use the scanner's artifact information; unknown artifacts are not guessed to be application dependencies. Package matches do not establish runtime reachability. A reported fixed package version is not a guarantee that a compatible replacement image has been published. Rebuild/redeploy deliberately and rescan to verify resolution.

The default view excludes services whose current successful deployment action is Stop and disconnected machines. It does not imply that every remaining workload is healthy or that its scan is fresh. **Stopped / disconnected** and **All workloads** retain access to those findings. Stopping a workload never marks vulnerabilities resolved.

The notification change retires old per-finding inbox alerts as read and cancels unsent legacy emails, retaining delivery history. Already-submitted emails cannot be recalled. Expired legacy sending leases are marked uncertain and are not retried. Existing sent alerts are not replayed into the new digest. No database migration or VPS helper upgrade is required for grouping or digest delivery.

## Credentials, audit and retention

The collector has a separate machine-scoped bearer credential stored under root-owned, mode-0700 `/var/lib/ephor-security`. Initial machine enrollment issues an independent Security ticket; the monitoring and deployment credentials cannot claim it. The ticket can be claimed only after monitoring connects. Regenerating or cancelling the pending machine invalidates all three tickets. Enrollment tickets expire after ten minutes and bind to the first generated credential, allowing the same enrollment to retry safely. Explicit Security repair or revocation supersedes the initial ticket, even before its first claim. Revoking Security collection invalidates its credential without revoking the monitoring daemon or deployment worker. The collector exits on revoked credentials. To remove it locally, stop/disable `ephor-security.service` and remove its unit, binaries and state directory through your normal administration process.

The combined installer attempts Security and deployment setup independently after monitoring connects. If either helper fails, it exits unsuccessfully with the corresponding repair instructions and leaves the successfully configured components running. Existing two-ticket enrollment commands must be regenerated before running the updated installer; they are rejected before local installation changes.

The root helper executes only fixed inspection/scanning operations, uses bounded command output and timeouts, and cannot receive arbitrary commands from the panel. The systemd unit restricts capabilities, filesystem writes and resource use. Docker socket access and host inspection are nevertheless privileged; the daemon binary and scanner are part of the host's trusted software.

Reports and batches of structured SSH events are buffered on disk until acknowledged. Uploads are idempotent and processed in bounded batches for D1 request budgets. Journal cursor loss, unavailable logs, first enrollment and event-volume limits create visible collection-gap events. No claim is made to capture every syscall or every host security event. Raw journal messages, container environments, registry credentials, process arguments and source mount paths are not uploaded.

The unified timeline combines collector events, findings, scans, existing panel activity and account audit records. JSON export follows pagination and fails explicitly rather than silently truncating large exports. Retention is 90 days by default (7–365 days configurable). It controls the unified timeline window, collector-event cleanup and older completed scan/resolved-finding cleanup. Active findings and latest scans are retained. Existing panel/account logs retain their existing storage policy. This is centralized audit history, not a tamper-proof or externally archived log.

## Verification

```sh
bun test --isolate packages/api/test apps/dashboard/test
bun run typecheck
bun run check:daemon
cargo test --workspace --locked
# Disposable nested Docker engine; never mounts the host Docker socket.
bun scripts/test-services-linux.ts security::
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run the same API security tests against PostgreSQL; the fixture creates and drops an isolated schema for each test. The Linux test downloads the pinned scanner, scans two real containers, verifies component attribution and secret exclusion, and confirms empty inventory is incomplete.

## Managed CrowdSec protections

Security → Overview → Managed protections (also on each machine's Security tab) manages an isolated CrowdSec installation. This first adapter detects SSH attacks only. It does not harden SSH, change default firewall policies, change public service exposure, filter Docker forwarding, or require Tailscale. Web application protection, Fail2ban, Tailscale and SSH hardening remain separate future integrations.

### Bootstrap and ownership

Apply migration `0022_managed_protections.sql` and build a daemon bundle advertising `protectionProtocol: 1`. From Protections, verify your passkey and generate the one-use, ten-minute management enrollment command. Run it once on the machine. This explicit grant is separate from automatic observational Security enrollment.

Supported hosts are Debian/Ubuntu with systemd, OpenSSH, `dpkg-deb`, and nftables (`/usr/sbin/nft`). If nftables is absent, install it with the distribution package manager before enrollment; Ephor does not enable the distribution's nftables service or replace its ruleset. Both x86_64 and aarch64 are supported.

The installer creates `ephor-protections.service`, a root-only identity and state under `/var/lib/ephor-protections`, and a static `ephor-crowdsec.service`. No CrowdSec install or blocking occurs until a panel job is approved. The existing collector credential cannot fetch or authorize management jobs. Management credentials cannot access monitoring or collector endpoints.

CrowdSec 1.8.2 packages are fetched from CrowdSec's official package repository and verified against architecture-specific SHA-256 hashes compiled into the helper. Packages are extracted into the private runtime directory; package maintainer scripts are not executed. The global package database, `/etc/crowdsec`, and existing CrowdSec installations are left alone. Hosts with a conventional external CrowdSec installation are read-only in this interface; automatic adoption is deliberately unsupported. Other/custom containerized installations should not be combined with this adapter.

The separate engine uses the official `crowdsecurity/sshd` collection, the `sshd` / `sshd-session` journal source, and an authenticated local API bound to `127.0.0.1:18765`. No online CrowdSec API credentials or community/console reporting are enabled. Installation needs outbound HTTPS to the official package repository and CrowdSec Hub. A port conflict fails installation visibly. Readiness checks establish that the configured source and collection exist; they do not certify comprehensive attack detection.

### Review and execute

Every mutation requires a fresh owner passkey session. Review creates a five-minute draft containing an immutable action, parameters and configuration revision. Approval queues that exact draft with a fifteen-minute deadline. Jobs are bound to the enrolled machine credential, fetched through outbound HTTPS, serialized per machine, and checked again locally against the configuration revision and an explicit action allowlist. No remote command, executable path, arbitrary URL, service name or shell fragment is accepted.

The helper persists a receipt _before_ executing a job. A crash cannot cause an action to execute again when delivery retries. Interrupted operations require a new reviewed repair job. Management enrollment rotation cancels pending jobs and revokes the previous credential. Revocation cannot undo an operation already executing; fixed operations remain bounded and blocking expires locally.

Approvals, actors, parameters, job outcomes and errors are available in the audit timeline and per-machine job history. Changes to eligible decisions and detection/blocking health are recorded in the audit timeline. Raw SSH logs and local API secrets are not uploaded. Changes reported by the helper describe local state, not independent attestation against a compromised root account. The control plane remains a trusted authority: compromise can exercise supported actions, including disabling protection. A VPN does not remove that risk.

### SSH blocking and recovery

Detection and blocking are separate. Installation starts detection with blocking off. Enabling blocking requires explicit administrator IP addresses, a healthy managed configuration and SSH source, and discoverable SSH ports that do not overlap 80 or 443. Trusted addresses accumulate; remote jobs cannot remove previously trusted addresses. Up to 100 current local CrowdSec `Ip` ban decisions from `crowdsecurity/ssh-*` scenarios are eligible. Community blocklists, ranges, manual decisions and web scenarios are excluded. Private, loopback, link-local, multicast and Tailscale CGNAT addresses are never blocked.

Ephor owns only the `inet ephor_crowdsec` nftables table. Its rules drop **new TCP connections to the detected SSH ports** from eligible IPs. They do not accept traffic past another firewall, change default policies, touch forwarding or output, or disrupt established sessions. Each entry has a kernel timeout of at most sixty seconds. Tables are replaced atomically; a failed verification pauses blocking.

The initial trial lasts two minutes. Open a **new SSH connection**, then explicitly confirm it in the panel. The panel cannot independently prove that SSH worked: confirmation is the administrator's attestation. Without confirmation the local trial expires. Losing panel authentication/contact for ninety seconds pauses blocking; kernel entry timeouts provide a second bound even if the process hangs. Reboots and helper restarts leave blocking off until explicitly enabled again. These availability safeguards intentionally prefer restoring access over retaining stale bans.

The one-hour exemption action immediately clears Ephor's current table and excludes the selected IP on subsequent refreshes; it does not erase CrowdSec's evidence. Repair/update first disable blocking. Updates install only the version pinned in the installed helper and refresh the SSH collection; a new engine version requires a reviewed helper release. Uninstall stops the isolated engine and removes its runtime/configuration, retaining the local database and receipts for recovery. Revoking management leaves detection installed but prevents further jobs.

For local recovery: stop `ephor-protections.service` (its stop hook clears owned blocking), or run `/usr/local/libexec/ephor-protections protection-reset` while the helper is stopped. Kernel bans also expire without refresh. Always retain provider-console access when changing remote access controls.

### Verification

API tests cover passkey/CSRF boundaries, separate credentials, one-use grants, immutable review payloads, concurrent approval, leases, revocation, stale revisions and parameter validation. Rust tests cover job validation, SSH-only rules, trusted/private-address exclusion and decision filtering. `deploy/daemon/protections-test.Dockerfile` exercises the real CrowdSec package, local API, collection installation and nftables in a disposable Debian container; the test image emulates systemd lifecycle commands only. It never mounts a host Docker socket or changes host firewall rules.

## Managed automatic updates

Use **Security → Overview → Managed protections → Automatic updates** to install/manage unattended-upgrades. The dialog selects one machine and exposes selected days, **Check for updates at**, and an optional **Reboot at**. Both times use UTC and can be chosen independently. Reboots default off. Review the exact policy and acknowledge service availability impact, then verify the owner passkey to approve. There is no immediate upgrade or reboot button. Pause and remove-management actions use the same review and approval flow.

The package name is `unattended-upgrades`. Its Debian/Ubuntu distribution logos identify supported systems; it has no separate product mark used here. The CrowdSec entry uses the official mark without text.

### Rollout and privilege boundary

Build the source bundles before the dashboard. The manifest now requires `managedUpdatesProtocol: 2` for management enrollment. Existing machines need **Automatic updates → Repair management helper**, followed by the generated administrator command. The collector remains independently credentialed and has no access to the protection helper's private directory. New management enrollment still does not install products or enable update/reboot policies.

No database migration is needed for this extension: typed update actions, parameters and normalized observations use the existing protection jobs and snapshots. Older helpers remain usable for CrowdSec but cannot accept new independent-time update plans. Previously saved policies retain their original authorization until explicitly replaced; old window-based drafts must be reviewed again. Tailscale is optional and no inbound management listener is added.

The restricted management daemon keeps its existing filesystem/capability sandbox. It writes a typed, root-only, expiring request and starts the fixed `ephor-updates-apply.service`. The root application entry point rechecks identity, credential fingerprint, deadline, APT configuration revision and action/parameter allowlists, then consumes the request before effects. It can install only the fixed unattended-upgrades package from the host's authenticated APT repositories, with insecure/unauthenticated repository modes explicitly disabled. Package maintainer scripts run with normal root privileges, as they do in a local package installation; this service does not accept commands, paths, repositories or shell text from the panel.

Installation runs independently of the helper's polling loop, so CrowdSec lease refresh continues. API jobs and local receipts prevent replay. Package transactions are never forcibly killed to satisfy a job deadline. A slow/interrupted install can remain visible as busy after authorization expires; policy enablement is checked again after installation and is refused after expiration, enrollment rotation or a local pause. Review machine state and package logs before retrying.

### Scheduling and reboot semantics

Ephor preserves underlying APT configuration and creates only:

- `/etc/apt/apt.conf.d/99zz-ephor-updates`
- `/etc/systemd/system/apt-daily-upgrade.timer.d/90-ephor.conf`
- `/etc/systemd/system/apt-daily-upgrade.service.d/90-ephor.conf`

The APT override clears inherited origin lists and allows only Ubuntu security/ESM-security or Debian Security origins. Existing held packages and package blacklists remain effective; ESM still requires appropriate repository access. Distribution upgrades and general third-party package updates are not enabled. Native unattended-upgrades reboots and install-on-shutdown are disabled while managed.

The standard upgrade timer starts at the selected UTC time on the chosen days. Random delay and persistent catch-up are disabled. A fixed condition verifies the owned files, effective APT origin/reboot policy, scheduled start minute, enabled state and fresh authenticated contact from the same boot. Package indexes are refreshed before upgrades; authorization is checked again after refresh so a check already started can continue beyond its start minute. A missed start is skipped until the next selected day. This controls the standard APT service, not arbitrary administrator cron jobs or manual commands.

If no security updates are available, nothing is installed. APT/dpkg operations can restart services and are allowed to finish safely; there is no configurable duration. Reboots use a separate fixed timer/entry point, only during the selected minute and day, only with a reboot-required marker, fresh panel contact, no active package process/service, no logged-in sessions and no conflicting systemd jobs. Shutdown inhibitors are respected. A blocked attempt is not repeatedly retried on that scheduled day. Loss of panel contact or credential revocation prevents new scheduled work after the 90-second contact lease; an already-started package transaction finishes normally.

Review/approval/results, observed policy changes, the APT successful-run timestamp and reboot-request timestamps are recorded through the existing security audit flow. A reboot-request timestamp records an attempt, not proof that the machine rebooted. The independent collector understands the managed schedule's maximum day gap so weekly schedules do not automatically receive the generic 48-hour stale-run recommendation; repair that helper too when upgrading older collectors.

### Pause, removal and recovery

**Pause updates** leaves unattended-upgrades installed and disables Ephor scheduling and reboot permission. **Remove management** removes only exact, unchanged Ephor-owned overrides and restores the prior upgrade timer enabled/active state. It leaves the package installed. The original APT policy then becomes effective again, including any previous automatic update/reboot settings; the review explicitly explains this. Configuration drift blocks remote changes rather than overwriting local edits.

For an immediate local hold, run:

```sh
sudo /usr/local/libexec/ephor-protections protection-updates-pause
```

This creates `/var/lib/ephor-protections/updates-paused`, preventing future managed starts/reboots and post-install enablement without killing active package transactions. Inspect the policy, package status and any interrupted setup before removing that marker locally. For partial setup or drift, inspect the three owned overrides and the root-only ownership record `/var/lib/ephor-protections/updates.json`; retain/back up local edits before removing/reconciling files, then run `systemctl daemon-reload`. Removing overrides restores underlying policy and may resume its automation. Do not remove the helper binary while the APT service override still references its schedule guard.

The isolated Linux integration test (`deploy/daemon/updates-test.Dockerfile`) installs the real package and validates APT policy, request consumption, scheduling/contact gates, pauses, drift refusal and removal. It emulates only service lifecycle/login inspection/reboot delivery; it never reboots a real machine. API tests run against SQLite and PostgreSQL and cover strict settings, fresh-passkey/CSRF boundaries, helper capability checks, revision changes and the shared immutable job flow.
