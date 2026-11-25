# Machine maintenance

Ephor installs one executable, `/usr/local/bin/ephord`, with one version and update policy. Monitoring, deployments/backups, security collection, protection management and the updater run different modes of that executable. They retain separate systemd units, credentials, state directories and permissions: sharing code does not give monitoring root access.

Use **Machines → your machine → Maintenance** for status, setup, repair and **Update Ephor on this machine**. Operating-system packages and hosted applications have their own lifecycles. The panel can run on Docker, a VPS, Railway, or Cloudflare Workers; update jobs and progress live in PostgreSQL or D1. Each managed Linux/systemd machine polls outbound over HTTPS. No SSH credentials or inbound agent port are required. A panel hosted on Workers or Railway does not need a local systemd service or a writable executable directory.

Official Worker installations and the official Docker/Railway image already
configure the official signed release channel. New machine enrollment enables
the updater automatically. Hosters do not need to generate signing keys, set
release variables, publish binaries, or run database migrations manually when
using official panel releases. The publishing instructions below are for
maintainers and custom release sources.

## Release setup (maintainer, once)

1. Generate a release signing key outside the repository, or in the ignored `.release-keys` directory:

   ```sh
   bun run release:daemon keygen .release-keys
   ```

   Back up `private.pem` securely. Never put it on a panel or VPS, commit it, or include it in a container image. `public-key.txt` is safe to distribute. A self-hoster using official builds needs only the official public key and release URL; a fork can generate its own key.

2. Push this repository to GitHub. Use public release assets: private GitHub downloads require authentication and cannot be used directly by the VPS updater. Create a protected GitHub Actions environment named `daemon-release`, with required reviewers and restrictions on release tags. Put the contents of `private.pem` in its `EPHOR_RELEASE_SIGNING_KEY` secret. Restrict who can push release tags and change the workflow. Enable GitHub immutable releases for the repository. See [GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) and [immutable release publishing](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository). These protections are repository settings; the workflow cannot configure them for you.

3. Ephor's first daemon release is `0.1.0`, tagged `daemon-v0.1.0`. For subsequent releases, increase the workspace version in `Cargo.toml`, update `Cargo.lock`, commit, and push a matching `daemon-v<version>` tag. `.github/workflows/daemon-release.yml` tests and builds static Linux x86_64 and aarch64 executables on parallel native runners, signs `release.json`, and publishes the assets. Every subsequent Ephor release must have a **strictly higher** numeric version. Never rebuild or replace assets under an existing version.

4. For a custom release source, configure both variables on each panel and restart/redeploy it:

   ```dotenv
   EPHOR_RELEASE_URL=https://github.com/OWNER/REPO/releases/latest/download/release.json
   EPHOR_RELEASE_PUBLIC_KEY=<contents of public-key.txt>
   ```

   Use a repository whose latest release is a daemon release. If you publish unrelated panel releases in the same repository, use a separate daemon release repository or a dedicated stable manifest URL on your own HTTPS host/R2 custom domain. The stable URL may move; the artifact URLs inside each signed manifest must stay version-specific. The panel and updater verify signatures independently, so a mirror cannot substitute its own binaries.

5. For a source installation, apply the database migration before starting the new panel:

   ```sh
   bun run auth:admin migrate
   # Cloudflare D1 instead:
   bun run auth:admin migrate --worker --remote
   ```

   `bun run dev:tunnel` already runs migrations on startup. Official container releases migrate on startup, and the Worker release updater applies migrations automatically. Source deployments must arrange their own migration step. For custom release channels, forward both variables into the server process or set both Worker variables (the public key is not a secret).

## Enable unified maintenance

Deploy a panel bundle containing **updater protocol 3**, alongside migration `0026_machine_maintenance.sql` (PostgreSQL or SQLite/D1). Source builds can create both architecture bundles with:

```sh
bun run bundle:daemon
EPHOR_DAEMON_LOCAL=1 bun run build
```

The official `daemon-v0.2.4` release provides `updaterProtocol: 3` and is pinned in `scripts/download-daemon.ts` for template deployments, including the README’s Deploy to Cloudflare button. The older `0.1.0` release remains immutable. Existing machines must run the Maintenance setup command once to migrate before they can claim protocol-3 updates. For future releases, publish a new signed version and update the template’s version and manifest checksum together. Building source locally does not publish a release.

New enrollment uses the shared executable immediately and enables the updater automatically on official installations. Custom source builds need a configured release URL and signing key. Existing machines use **Maintenance → Get setup or repair command** once, after passkey verification. Run that command on the enrolled Linux/systemd machine with sudo access within ten minutes. It downloads one checksummed candidate, snapshots the old layout, replaces the canonical executable and converts existing `/usr/local/libexec/ephor-{services,security,protections,updater}` copies into compatibility symlinks. New unit definitions invoke `/usr/local/bin/ephord` directly. Existing units and OS-update guards that reference old paths continue working through those aliases. Unexpected symlinks, unsafe permissions and component downgrades are rejected.

Migration preserves identities, configuration and signing trust, and restarts only roles that were active. Setup then configures deployment/security roles and the updater; stopped existing deployment/security/protection units remain stopped. Monitoring must already be enrolled. Repair cannot silently rotate the pinned signing key. Role installers configure services and dependencies, but cannot replace the shared executable; they reject a panel bundle whose checksum differs from the installed binary. Bring the panel bundle and machine to the same release before configuring additional roles.

Protection management is included when already authorized, or when explicitly selected in the Maintenance tab. Generating the command preserves an existing management credential until enrollment. Connecting management does not enable OS updates, reboots or firewall blocking. Missing components are never installed by a normal remote update.

Setup takes the same local lock as remote updates and reserves a server maintenance window before modifying the installation. Existing work causes it to stop; new claims pause until setup exits. A lost cleanup request or crashed machine releases the server reservation after an hour. Migration and role setup share a 55-minute timeout so they cannot continue beyond that reservation. Generate a fresh command to retry an expired enrollment.

Within roughly 35 seconds, the page reports one installed version and the running/stopped state of each role. Click **Update Ephor on this machine**, confirm and verify your passkey. One signed artifact replaces the shared executable once. The updater pauses new machine jobs and refuses to interrupt active deployments, builds, backups, scans or protection actions. Active helpers restart; previously stopped helpers remain stopped. Application containers keep running. Restarting the protection helper resets its temporary blocking rules; review protection status afterward before enabling blocking again.

Choose one policy in Maintenance, with fresh owner passkey verification:

- **Ask before updating** (default): each update needs approval and a passkey.
- **Automatically install signed releases when idle**: the updater checks the release source and queues compatible signed releases after active work finishes. A release already attempted, including a failed or rolled-back release, needs a manual retry; automatic mode never loops on the same failed build.
- **Keep the installed version**: pins the reported installed version. Change the policy to upgrade; pinning does not downgrade the machine.

Policy changes are blocked during a pending update or unresolved recovery. Legacy protocol-1 monitoring-only jobs and protocol-2 multi-copy jobs remain supported on unmigrated machines. Shared installations require protocol 3 at both ends; old clients cannot claim these releases. The panel itself is maintained on the **Updates** page, regardless of its hosting provider.

## What is verified

- Ed25519 signature over the exact UTF-8 manifest bytes; pinned trust on both panel and VPS.
- Manifest schema, stable channel, layout compatibility, expiry, architecture and version. Downgrades are blocked. Protocols 2 and 3 allow same-version repair when the installed build differs; matching versions/build IDs do not create a redundant job. Publishers must still use a new version for every release.
- HTTPS transport using the operating system's trusted CA certificates; no environment proxy, credential forwarding to artifacts, or HTTP redirects for agent API calls.
- Artifact SHA-256 and exact size, with a 32 MiB maximum, before replacement.
- Root ownership and permissions for state and executable paths. Remote shared updates write only the canonical executable and updater state; migration uses fixed legacy paths and fixed systemd units. Jobs cannot supply shell commands, unit names or file paths.
- Monitoring must send fresh telemetry with the expected version **and build identity**. Each replaced binary must report the expected build. Active roles must restart successfully; the updater checks the running executable hash where Linux permits it, otherwise it verifies systemd's executed path, exact role arguments and PID. This keeps the updater capability-free even when another role has elevated capabilities. The replacement updater must parse the existing configuration and recovery journal. Binary versions/build IDs come from build inputs, not a user-editable panel field.

The monitoring service remains unprivileged. The root updater runs from `ephor-updater.timer` and has write access only to `/usr/local/bin` and its state directory, not `/usr/local/libexec`. It downloads and verifies before backing up the shared executable, records a root-only recovery journal, then atomically renames the replacement. The current updater process finishes using its original inode. The new updater must understand both legacy recovery journals and the shared journal (`shared: true`).

A failed restart or health check restores the previous shared executable and the roles' previous active/stopped state. A crash during replacement is recovered from the journal on the next run. Terminal receipts are retried without reinstalling the job. Shared database admission leases serialize job claims with maintenance on PostgreSQL and D1; a crashed admission request times out after a minute. Only one update runs per machine.

Trust-key rotation still requires local administration. Do not remove the journal or change the pinned key during maintenance.

Release metadata expires after 90 days. Publish a newer release before expiry; expired manifests cannot authorize new installs. Existing agents continue monitoring. A compromised signing key can authorize malicious releases, so key custody and release-review protections are essential. Signing does not make malicious signed code safe.

## Failure recovery

Check these on the VPS:

```sh
sudo systemctl status ephor-updater.timer ephor-updater.service ephord.service ephor-services.service ephor-security.service ephor-protections.service
sudo journalctl -u ephor-updater.service -u ephord.service --since '20 minutes ago'
```

A failed download leaves the existing binary intact. A rolled-back update retains the previous version and may be retried after resolving the failure. Requests expire after 15 minutes; **Completion unknown** means the panel has not received a final receipt. If replacement had started, new machine jobs and further maintenance stay blocked until the updater reports success or recovery. Inspect the VPS before retrying. A crash before acknowledged installation does not restart any helpers. A later receipt reconciles the status. Network loss during health verification causes a conservative rollback.

If restoring or restarting also fails (disk errors, changed systemd unit, permission problems), the helper leaves its journal intact and tries recovery again on its next run. Resolve the host problem before requesting another update. The shared executable backup is `/var/lib/ephor-updater/previous`; legacy protocol-2 backups are `<component>.previous`. Do not replace them with unverified downloads.

Migration uses a separate private `layout.json` journal and `layout-<component>.previous` backups. A failed migration restores the original files/aliases and restarts previously active roles. A capable updater recovers an interrupted migration automatically. If power failed before converting the old updater, use the retained recovery executable locally:

```sh
sudo /var/lib/ephor-updater/layout-recovery recover-layout
```

Then generate a fresh setup command. The recovery executable is removed after successful migration. Keep the private journal/backups intact until recovery is complete. A later failure while configuring a role leaves the successfully migrated shared executable in place; rerunning setup repairs that role.

Revoking a machine prevents subsequent polling and API reports. It cannot cancel a binary replacement that the updater has already started. Updates restart the previously active Ephor helpers, not Docker, application containers or the VPS.

## Publishing somewhere other than GitHub

Build, then sign with version-specific HTTPS artifact URLs:

```sh
bun run bundle:daemon
EPHOR_RELEASE_SIGNING_KEY_FILE=.release-keys/private.pem \
  bun run release:daemon sign apps/dashboard/public/daemon \
  https://downloads.example.com/daemon/0.2.2/ \
  /tmp/ephor-release.json
```

Upload the binaries to those version-specific URLs, then publish the signed file at the panel's configured stable manifest URL. Do not regenerate the signed JSON or alter its embedded `manifest` string. The signing command checks bundled binary checksums and verifies its own signature before writing. It refuses to overwrite an existing output file. Set `EPHOR_RELEASE_PUBLIC_KEY` when signing to require the corresponding private key; official release CI checks it against the key in the Cloudflare template before publication.

## Validation

`bun run test` covers signature validation, API authorization, queue concurrency, cross-machine isolation, expiry, and receipts on SQLite (and PostgreSQL when `TEST_DATABASE_URL` is set). `cargo test --workspace --locked` checks daemon signature and version handling.

`bun run test` also exercises architecture artifact assembly, signing, checksum and version rejection, and the Linux integration harness's failure handling. Service integration tests run individually, stop on the first failure, and run the lengthy catalog sweep last. Their disposable Docker engine uses a dedicated address pool so retained recovery fixtures cannot exhaust Docker's default pools.

The optional Linux integration test runs the production executable against the real API over verified HTTPS in an unprivileged Docker container. It checks legacy compatibility, migration, unsafe-link rejection, one-inode convergence, inactive/absent roles, lost receipts, tampering, rollback and crash recovery. Only systemctl is replaced by a harness that launches the real executable; this does not substitute for testing actual systemd sandboxing on a deployment VPS.

```sh
bun run bundle:daemon
# Use the native Docker architecture; /proc executable checks intentionally reject emulation wrappers.
docker build -t ephor-updater-test -f deploy/daemon/test.Dockerfile .
EPHOR_TEST_LINUX_UPDATER=1 bun test packages/api/test/updater-linux.test.ts
```

## This repository

Official release repository: [rasmussensolutions/ephor](https://github.com/rasmussensolutions/ephor).

```dotenv
EPHOR_RELEASE_URL=https://github.com/rasmussensolutions/ephor/releases/latest/download/release.json
EPHOR_RELEASE_PUBLIC_KEY=69fcf97385688a836880535bad05d49fcf2b4a09bd54315546c458efe3d53b2b
```

Verify the public key against a trusted copy before bootstrapping a VPS. The release signing key is kept separately from the source and panel configuration.
