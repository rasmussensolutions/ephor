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

You need Node.js 22 or newer and curl on the computer running the installer.
Download the small bootstrap, inspect it if desired, then run it for your host:

```sh
curl -fL --proto '=https' https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/install.sh -o install-ephor.sh
sh install-ephor.sh cloudflare
# or: sh install-ephor.sh railway
# on a Linux Docker host: sudo sh install-ephor.sh docker
```

The bootstrap verifies the signed release and installer checksum before running
it. Builds happen once in Ephor's release workflow. A release includes the pinned
image digest, Worker code, assets, migrations, and installer/updater. Save the
setup code and authentication secret printed by the installer in your password
manager. Enter the setup code on the panel, register your passkey, and save your
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

Create an empty Railway project and a **project token** scoped to the intended
environment. Set it privately, then run:

```sh
read -r -s RAILWAY_PROJECT_TOKEN; export RAILWAY_PROJECT_TOKEN
sh install-ephor.sh railway
unset RAILWAY_PROJECT_TOKEN
```

Supply the project and environment IDs. The installer creates PostgreSQL 17 and
the Ephor image service, attaches their persistent volumes, configures private
database networking, creates an HTTPS domain, and deploys. The project token is
stored as a service secret and the panel encrypts its update connection in the
database. Use a dedicated project/environment. Railway charges for these services
and volumes under your plan. A panel volume mounted at **/data** is required;
Ephor refuses to start on Railway without it.

### Docker / VPS

On a Linux host with Docker Engine, Compose v2, Node.js 22+, and systemd, run
`sudo sh install-ephor.sh docker`. Supply the public HTTPS origin. Point your
existing reverse proxy at `127.0.0.1:3002`. PostgreSQL is private to the Compose
network. Configuration is root-readable under `/var/lib/ephor`.

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
  Connect the existing service/environment and project token in Hosting setup.
  Do not replace the database service or its volume.
- **Docker:** the adoption path supports the existing Ephor PostgreSQL 17 Compose
  layout, database/user `ephor`, and hexadecimal database/authentication secrets.
  Back up the database, stop the old panel and database containers **without
  deleting volumes**, and copy the existing `EPHOR_ORIGIN`, `EPHOR_DB_PASSWORD`,
  and `BETTER_AUTH_SECRET` values into root-readable `/var/lib/ephor/.env`.
  Run `sudo sh install-ephor.sh docker --adopt` and select the existing PostgreSQL
  volume. The installer refuses a volume still used by a running container and
  preserves it as an external volume. For a custom/external database or a different
  PostgreSQL major version, migrate into the managed layout using a verified
  backup first; do not point PostgreSQL 17 at another major version's data files.

Installation failures print created resource IDs. Inspect those resources before
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
The protected signing job assembles the multi-platform digest and signs the
release using the pinned Ed25519 key. Never overwrite versioned assets.

The signing environment must allow `panel-v*` tags and retain its reviewer/key
protections. GHCR package `rasmussensolutions/ephor-panel` must be public before
announcing the first release; verify an anonymous digest pull. The `panel-channel`
branch contains only the signed channel pointer and bootstrap. Versioned GitHub
releases stay immutable. Panel releases
must use `--latest=false` so daemon discovery remains independent. Publish the
versioned assets before moving the stable pointer. Test a disposable deployment
before announcing a new release. Hosts never build or run `git pull` to update.
