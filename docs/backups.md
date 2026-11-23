# Off-site backups

Ephor backs up catalog apps and custom services with managed persistent volumes
using Restic 0.19.1 and S3-compatible object storage.
It supports Cloudflare R2, Backblaze B2, Amazon S3, DigitalOcean Spaces, Wasabi,
and Hetzner Object Storage. Storage remains in the owner's account. Data travels
directly from a managed machine to storage, encrypted before upload.

## Setup

1. Apply database migrations, deploy the updated panel, and build/publish the
   daemon artifacts (`bun run bundle:daemon`). Upgrade each deployment worker
   using the machine's **Settings → Deployments**. Legacy catalog backup jobs require service protocol 4;
   custom volumes, Qdrant, and database resource overrides require protocol 6.
   Older workers continue to support their existing deployment operations.
2. Create a private, dedicated bucket and bucket-scoped S3 credentials. R2 uses
   the account ID and region `auto`; B2 uses its S3 region, application key ID,
   and application key. Other providers use the bucket region. The initial
   release accepts provider-derived HTTPS endpoints, without arbitrary hosts,
   ports, paths, insecure TLS, or custom CA overrides. Bucket names currently
   allow lowercase letters, numbers and hyphens. Jurisdiction-specific R2
   endpoints are supported for EU, US and FedRAMP; choose the bucket’s jurisdiction
   in the form (a location hint is not a jurisdiction restriction). A mismatched
   jurisdiction can return Access Denied even with valid keys. Custom S3 servers
   are not yet supported by the setup form.
3. In **Backups**, add storage and choose a machine to check it. Ephor initializes
   an encrypted test repository, writes a test snapshot, reads it back, and runs
   Restic's complete repository data check. A destination is usable only after
   that worker reports success. Failed checks can be retried.
4. Select a deployed persistent service, the destination and schedule. Download its
   recovery kit and store it in a password manager outside the managed servers.
   Run **Back up now** to create the first usable backup.

A connection check verifies access and data integrity. It does **not** certify
provider immutability, bucket privacy, credential scope, or deletion resistance.

## Schedules and execution

Daily and weekly (Sunday) schedules use an explicit UTC hour. The existing
outbound worker poll drives due jobs on both PostgreSQL and D1 deployments; no
additional panel cron service is needed. Offline machines catch up once when they
reconnect, without replaying every missed interval. Queuing and schedule advancement
are idempotent. Changing the schedule to Manual stops future scheduled jobs; it
does not cancel an already queued operation.

Operations are serialized by the deployment worker's exclusive process lock.
Running jobs are not timed out and reassigned to another machine. A durable,
root-only receipt survives lost HTTP responses. After a worker interruption, the
operation is marked failed rather than repeating a potentially destructive step.
Interrupted catalog mutations use the existing recovery-required mechanism.

For each backup, Ephor stops the service's writers and creates checksummed
cold archives of all data volumes. It then resumes an app that was running before
uploading. A stopped app stays stopped. The snapshot includes a manifest with the
recipe fingerprint, immutable image references, volume keys, and app secrets.
Restic encrypts this manifest along with the archives. Only after a successful
upload, manifest read-back, and full repository data check is the backup marked
successful. The temporary local recovery point is then removed; existing owner
recovery points are preserved. Failed operations may retain local recovery points
or incomplete volumes for inspection. Monitor local disk space.

Recipe compatibility fingerprints cover runtime configuration, not catalog names,
descriptions, or icons. Recognized initial fingerprints are upgraded when the app
next completes an operation and remain accepted for restoring existing backups.
Actual runtime recipe differences still require a compatible worker or reviewed
app migration; they are reported separately from snapshot or storage failures.

The full data check reads all repository data and can increase bandwidth/time as
history grows. Jobs have a two-hour deadline per Restic command and a 512 MiB helper
memory budget. Very large repositories may require future tuning.

## Restore onto another machine

Choose a completed backup in History, then **Restore**. Select an enrolled machine
with an online compatible worker (protocol 6 for custom volumes, Qdrant or resource
overrides) and the same CPU architecture. Provide a new service
name and, for web apps, an unused domain. The original machine need not be online.

Ephor fetches the exact snapshot ID, verifies its manifest against the compiled
recipe and saved configuration, downloads with Restic's `--verify`, and checks each
archive before extraction into new, labeled volumes. It starts the same pinned
app recipe and runs its existing health checks. Web apps start with access protection
enabled. Ephor never changes the original service, reassigns its domain, or changes
DNS. Inspect the restored app before switching clients or traffic.

Custom-service backups use the last successful deployment's image and environment,
not pending configuration edits. Locally built images are checksummed and included
inside the encrypted repository, so loss of the source Docker engine does not lose
the application image. A custom restore creates a separate image service with no
public domain or production database network attachments. It starts the saved
image and retained environment: external URLs, tokens and outbound connectivity
still work, so review possible external side effects before restoring production
applications. Reconnect dependencies and repository deployment explicitly after
validation. Backups are cold snapshots, not PostgreSQL PITR or live replication.

The restored worker must still include the matching recipe fingerprint. A newer
recipe is not silently substituted for a database's original version. Restoring
cross-architecture database files is intentionally rejected. The target needs space
for both the downloaded archives and extracted volumes, plus safety headroom.
Completed database restores do not imply an application-level audit of every record.

## Credentials, encryption and deletion protection

Storage credentials and repository passwords are encrypted in the panel database
with record-bound AES-GCM. Each app plan gets a random repository password and a
separate repository prefix. Credentials are delivered only to the assigned worker
and are passed to containers over the Docker Unix API, never host command arguments.
Helper containers mount only Ephor-owned volumes, use a read-only root filesystem,
drop capabilities, and never receive a Docker socket or host bind mount. Their
image is digest-pinned. Root-only local job state necessarily contains credentials
while a job is pending; the worker removes it after its receipt is acknowledged.

List endpoints return no credentials. Creating destinations, changing schedules,
manual backups, restores, and recovery-kit exports require a fresh passkey and the
exact panel origin. Activity records contain operation IDs and fixed error codes,
not provider output or secrets.

A per-app repository prefix is **not** an access-control boundary if the supplied
storage credential grants access to the entire bucket. Use separate destinations
and narrowly scoped credentials when machines must not share a storage trust
boundary. A compromised machine can read its mounted data and the keys issued to
it. Encryption does not prevent deletion or replacement of repository objects.

For stronger deletion protection, configure provider-side versioning/retention and
keep permanent-deletion and retention-bypass privileges off managed machines. Test
provider-specific recovery before relying on it. Restic needs read/list/write
access and must be able to remove its transient lock objects; a blanket denial of
all deletes or a blanket Object Lock policy can break normal operations. This
release does not claim append-only or ransomware-proof storage.

Remote backups are retained indefinitely by Ephor in this release. There is no
automatic prune or bucket lifecycle deletion. This deliberately avoids issuing
permanent data-deletion operations from application machines. To remove old history,
use Restic from a separately trusted maintenance environment, preview `forget`
with `--dry-run`, then apply an appropriate retention policy and `prune`. Run `check`
afterwards. Never expire individual Restic data objects through a bucket lifecycle
rule: newer snapshots can still reference them. History displays the latest 500
operations; older remote snapshots remain accessible through the recovery kit.

## Recovery without the panel

The exported JSON recovery kit contains the repository URL, encryption password,
region and storage credentials. Treat it as a secret. Losing the only remaining
repository password makes the encrypted data unrecoverable. If access credentials
are revoked, obtain new credentials from the storage account and keep the same
repository URL and password.

With Restic installed, set `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION` through a
private environment or secret files. Do not paste credentials into shell history.
Run `restic snapshots`, then `restic restore <full-snapshot-id> --target ./recovered
--verify`. The restored `data/manifest.json` identifies the app recipe, images,
configuration and secrets. Custom locally built images also include `data/image.tar`
and `data/IMAGE_SHA256SUMS`; verify the checksum and load that image before starting
the saved image ID. Registry images require continued access to their pinned digest.
Each `data/volumes/<key>/data.tar` has a `SHA256SUMS`
file. On an isolated recovery host, verify those archives and extract them into
fresh volumes with ownership preserved; start the matching recipe with its saved
secrets. The current UI restores from the panel's saved backup history; importing
a recovery kit into a completely new panel is a manual recovery procedure.

Back up the panel separately: take a consistent PostgreSQL database backup or D1
export and store `BETTER_AUTH_SECRET` separately in a password manager. These
app backups do not include the panel database, owner passkeys, sessions, or machine
enrollment state. Follow docs/authentication.md when restoring stale authentication
state. Never rely on the only recovery key being inside the database it unlocks.

## Verification

`bun test packages/api/test/backups.test.ts` covers provider validation, encryption
and redaction, owner/worker boundaries, UTC scheduling, duplicate polls, crash-safe
schedule advancement, source-offline restores and architecture checks. It also runs
against PostgreSQL when `TEST_DATABASE_URL` is set.

`bun run test:services:linux services::backup::tests::restic_s3_roundtrip_after_source_loss`
builds a disposable nested Docker engine, creates an S3-compatible Moto fixture,
backs up a real PostgreSQL catalog app, deletes the original containers and volumes,
and verifies the restored database contents using only the remote snapshot and a
new worker state. The fixture's HTTP storage exception is compiled only in tests;
production workers accept only the documented HTTPS provider endpoints.

Restic's license and image attribution are in THIRD_PARTY_NOTICES.md.

After an interrupted Restic process, a stale repository lock may remain. From a
trusted maintenance environment, first confirm no backup or restore is still
running, then use `restic unlock` to remove stale locks. Never use
`--remove-all` while another operation might be active. Storage-key rotation is
available on the destination card; it requires a new successful connection check.
Download fresh recovery kits after rotation so their storage credentials stay current.
