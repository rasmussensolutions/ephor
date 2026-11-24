# Install and update Ephor

Ephor hosts install official releases. You do not need to fork, clone, merge, or
build this repository. Docker and Railway run the official container image;
Cloudflare runs a native Worker with prebuilt dashboard assets, not a container.

The installer connects updates once. Afterward open **Updates → Check for updates
→ Update to …** and authorize with your passkey. The page reconnects during a
restart and confirms the version actually running. Closing the browser does not
cancel an approved update. Machine components remain together under each
machine's **Maintenance** tab.

## Install

For a **VPS**, use the [one-command setup below](#docker--vps). It installs its
own dependencies and HTTPS; no Node.js is needed.

For **Cloudflare or Railway**, you need Node.js 22 or newer and curl on your own
computer. Download the small bootstrap, inspect it if desired, then run the wizard:

```sh
curl -fL --proto '=https' https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/install.sh -o install-ephor.sh
sh install-ephor.sh cloudflare
# or: sh install-ephor.sh railway
```

The bootstrap verifies the signed release and installer checksum before running
it. Builds happen once in Ephor's release workflow. A release includes the pinned
image digest, Worker code, assets, migrations, and installer/updater. Save the
setup code in your password manager and keep the authentication secret safe
(the VPS stores it in root-readable `/var/lib/ephor/.env`; cloud wizards print it). Enter the setup code on the panel, register your passkey, and save your
recovery codes. The initial installer uses a terminal; subsequent updates happen
in the panel. No repository connection is necessary.

### Cloudflare Workers

Create an account-scoped API token with **Workers Scripts Edit** and **D1 Edit**.
Cloudflare scopes these permissions to an account, not to one individual Worker;
use a dedicated account if you need a stronger deployment boundary. Enter the
token without putting it in shell history:

```sh
read -r -s CLOUDFLARE_API_TOKEN; export CLOUDFLARE_API_TOKEN
sh install-ephor.sh cloudflare
unset CLOUDFLARE_API_TOKEN
```

The wizard asks for the account ID and Worker name, creates D1, deploys the signed
release, sets private secrets, enables the workers.dev address and minute cron,
and stores the update connection encrypted in D1. Accept the proposed workers.dev
origin for the simplest install. For a custom domain, attach it to that same
Worker in Cloudflare and use its exact HTTPS origin without a trailing slash.
Existing custom domains remain attached during updates.

The built-in **Deploy to Cloudflare** repository button creates a deployment copy
and builds source. It is no longer the recommended installation method. Native
Workers do not need Cloudflare Containers.

### Railway

Create an empty Railway project and a **workspace-scoped API token** from
Railway account settings, selecting the workspace containing that project.
Use a dedicated workspace for Ephor: the token can manage other projects in
that workspace. Project deployment tokens cannot provision services or change
release image configuration. Set the token privately, then run:

```sh
read -r -s RAILWAY_API_TOKEN; export RAILWAY_API_TOKEN
sh install-ephor.sh railway
unset RAILWAY_API_TOKEN
```

Supply the project and environment IDs. The installer creates PostgreSQL 17 and
the Ephor image service, attaches their persistent volumes, configures private
database networking, creates an HTTPS domain, and deploys. The workspace token is
stored as a service secret and the panel encrypts its update connection in the
database. Use a dedicated workspace and project. Railway charges for these services
and volumes under your plan. A panel volume mounted at **/data** is required;
Ephor refuses to start on Railway without it.

### Docker / VPS

Start with an x86-64 or ARM64 VPS running **Ubuntu 22.04/24.04/26.04** or
**Debian 12/13**, with systemd, root/sudo access, and enough disk space for Docker
images and backups. Point a domain's A record (and AAAA only if IPv6 works) at
the VPS. Allow inbound **TCP 80 and 443** in the provider and host firewall.
Keep port 80 open for automatic certificate issuance/renewal. UDP 443 is optional
for HTTP/3. Then run over SSH:

```sh
curl -fsSL --proto '=https' https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/install.sh | sudo sh -s -- vps --domain=panel.example.com
```

Replace `panel.example.com` with your domain. You can also download the script
first and run `sudo sh install-ephor.sh vps`; it prompts for the domain. `docker`
is an alias for `vps`.

The bootstrap verifies the release signature and downloads the matching
standalone Linux installer. It installs Docker Engine and Compose from Docker's
signed package repository when missing, creates private PostgreSQL storage,
starts the released panel and Caddy HTTPS proxy, waits for verified HTTPS, and
prints the URL and one-time setup code. Open that URL, enter the code, and register
your passkey. Certificates renew automatically. Neither Node.js nor a source
checkout is needed on the host.

Configuration and credentials are root-readable under `/var/lib/ephor`; Caddy's
certificates persist in Docker volumes. The database has no public port, and the
panel's direct port is bound only to `127.0.0.1:3002`. The updater and proxy image
are included in signed panel releases, so updates continue through the panel.
The host operating system and Docker Engine still need normal security updates.

If setup is interrupted, rerun the same command: it resumes the same release,
credentials and database. A completed installation reports its URL without
reinitializing it. It refuses a different domain or occupied ports instead of
replacing other services. DNS/provider firewall settings cannot be configured
without access to your provider; certificate failures explain what to check.

**Existing HTTPS proxy:** add `--external-proxy` to keep your current proxy and
forward the domain to `127.0.0.1:3002`. This explicitly skips managed HTTPS and
port 80/443 checks. Other systemd Linux distributions work when Docker and
Compose v2 are already installed. The installer preserves an existing Docker
engine; if Compose is missing, it tries the plugin available from existing
trusted package sources.

The installer creates an `ephor-updater` systemd timer. Every 30 seconds it checks
for an owner-approved job. Only this host process has Docker authority. The web
panel runs as UID 1000 and has no Docker socket, shell-command endpoint, or
host filesystem mount apart from its backup directory. The updater independently
verifies the release signature, allowed registry and image digest, and keeps a
monotonic local release ledger. It also updates its own installer executable from
the verified release. It never accepts a command or image URL from a browser.

## Existing source installations

Back up the database and keep the exact `BETTER_AUTH_SECRET`, database, origin,
and owner credentials. Do not run first-time setup again. Disable repository build
triggers before adopting releases; a later Git push could otherwise replace an
installed release. The old GitHub Updates App is no longer needed: revoke it in
GitHub after adoption. The separate read-only GitHub App for deploying your own
services is unchanged. Legacy integration records are retained, not silently
removed.

- **Cloudflare:** run `sh install-ephor.sh cloudflare --adopt` with the existing
  Worker name and origin. Confirm that its Git build trigger is disabled. The
  installer verifies the existing D1 binding, records a Time Travel bookmark,
  applies only missing migrations, and inherits the existing bindings and secrets.
  Then connect the account ID, Worker name, D1 ID, and API token once under
  **Updates → Hosting setup**. It does not create a replacement database.
- **Railway:** disconnect the panel's GitHub source, keep its database and secret
  variables, and attach a persistent volume at `/data`. Switch the service source
  to the digest from the signed release, clear the old build/start/pre-deploy
  overrides, and use `/health`. The official image backs up and migrates on start.
  Connect the existing service/environment and workspace API token in Hosting setup.
  Do not replace the database service or its volume.
- **Docker:** the adoption path supports the existing Ephor PostgreSQL 17 Compose
  layout, database/user `ephor`, and hexadecimal database/authentication secrets.
  Back up the database, stop the old panel and database containers **without
  deleting volumes**, and copy the existing `EPHOR_ORIGIN`, `EPHOR_DB_PASSWORD`,
  and `BETTER_AUTH_SECRET` values into root-readable `/var/lib/ephor/.env`.
  Run `sudo sh install-ephor.sh docker --adopt` and select the existing PostgreSQL
  volume. The installer refuses a volume still used by a running container and
  preserves it as an external volume. Adoption keeps your existing HTTPS proxy;
  it does not take over ports 80/443. For a custom/external database or a different
  PostgreSQL major version, migrate into the managed layout using a verified
  backup first; do not point PostgreSQL 17 at another major version's data files.

Cloud installation failures print created resource IDs. Inspect those resources before
retrying so you do not create duplicates. A failed initial Cloudflare install can
be continued with `--adopt`; retain the original setup/authentication secrets.

## Recovery and security

- Owner sessions are required to read settings; hosting changes and update
  approval require a fresh passkey. Provider tokens never appear in status
  responses or client-side storage. They are encrypted with authenticated,
  per-record encryption under the installation's authentication secret.
- Only official Ed25519-signed releases are accepted. Artifact sizes and SHA-256
  checksums are checked before use. Provider requests reject redirects; public
  artifact downloads follow only GitHub's release CDN redirects, without tokens.
  Once a newer release has been observed, older channel metadata is rejected.
- Jobs have a database-backed lease and durable stages. Deployment acceptance is
  not success: the matching compiled version must acknowledge startup. A lost
  provider response is reconciled without blindly starting another deployment.
  Inspect provider logs for stalled/failed jobs before retrying. An attempt times
  out after an hour. A failure never deletes the recovery information.
- Cloudflare saves a **D1 Time Travel bookmark** before migrations. Its usefulness
  is bounded by your plan's retention period. Missing SQL migrations and their
  ledger entries run atomically. Bindings, secrets, and custom domains remain on
  the same Worker. Keep its minute cron enabled for background updates.
- Container startup takes a **pg_dump custom archive** before pending migrations,
  then migrates in one transaction under a PostgreSQL advisory lock. Backup failure
  prevents migration/startup. Archives are private under `/data/backups` (Docker:
  `/var/lib/ephor/data/backups`). Retain them off-host according to your backup
  policy; monitor available volume space. No archive is automatically deleted.
- Database rollback is **not automatic**. A previous image may be incompatible
  with a migrated schema. Restore into a separate database with `pg_restore`,
  verify it, and point a compatible release at it; for D1 use the saved bookmark
  through Cloudflare's recovery controls. Recovery can discard writes made after
  the recovery point. Keep the authentication secret with your backups.

Docker diagnostics:

```sh
sudo journalctl -u ephor-updater.service
sudo systemctl status ephor-updater.timer
sudo docker compose --project-name ephor --project-directory /var/lib/ephor logs panel
```

A crashed host updater leaves a lock and release ledger. Inspect the process and
container state before removing `/var/lib/ephor/updater.lock`; never run two
updaters concurrently. If the new panel cannot start, use provider/host access to
recover it—the failed application cannot repair its own database from the UI.

## Publishing (maintainers)

Bump `PANEL_VERSION` and `PANEL_SEQUENCE` together in
`packages/api/src/panel/release/version.ts`, review migration compatibility, and
push a `panel-vX.Y.Z` tag. `panel-release.yml` runs the application and native
Workers tests before building AMD64 and ARM64 images on Blacksmith. Each image
must pass fresh install, restart, real backup, migration, health and UID checks.
A separate disposable Linux host test starts without Docker or Node and checks
automatic dependency installation, port conflicts, interrupted-install recovery,
HTTPS routing, native systemd polling and preservation during updates. It uses a
trusted local test certificate; public ACME issuance requires a real domain.
Standalone installers are built for baseline x86-64 and ARM64 with local runtime
configuration autoloading disabled.
The protected signing job assembles the multi-platform digest and signs the
release using the pinned Ed25519 key. Never overwrite versioned assets.

The signing environment must allow `panel-v*` tags and retain its reviewer/key
protections. GHCR package `rasmussensolutions/ephor-panel` must be public before
announcing the first release; verify an anonymous digest pull. If the organization
blocks public packages, an owner must allow public package creation while making
this package public; the organization restriction can then be restored. The `panel-channel`
branch contains only the signed channel pointer and bootstrap. Versioned GitHub
releases stay immutable. Panel releases
must use `--latest=false` so daemon discovery remains independent. Publish the
versioned assets before moving the stable pointer. Test a disposable deployment
before announcing a new release. Hosts never build or run `git pull` to update.
