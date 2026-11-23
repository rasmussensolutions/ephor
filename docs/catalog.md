# App catalog

Ephor includes reviewed, versioned recipes for PostgreSQL, Redis, Uptime Kuma,
WordPress + MariaDB, Umami + PostgreSQL, and Qdrant. Each app is one service in the panel,
with its own containers, private dependency network, persistent volumes, logs and
aggregate resource metrics. Catalog recipes ship with the panel and are compiled
into the Linux worker. No Ephor account or external catalog service is required.

## Component map and drawers

**Machines → Canvas** groups the components of each installed template
inside a subtle app boundary only when the template has multiple components.
Single-component templates such as PostgreSQL, Redis, and Uptime Kuma are plain
service cards. The primary component uses the app name (for example,
Umami instead of “web”) and opens the main drawer with deployments, primary
component metrics/logs/variables, domain setup, and app data controls. Its domain
row opens the Domains tab directly. Private database apps do not offer public
domain setup. Dependency cards use recognizable names such as PostgreSQL and
open their own component drawers.

Cards use neutral borders; the primary label identifies the main component.
Drag a card to snap its top-left corner to the shared 24px dotted grid, drag a group header to move its
contents together, or rearrange components inside a group. Group bounds and
dependency arrows follow the cards. Alt + arrow keys move a focused card or
group title by one grid step (Shift moves four steps). Group components use the
same canvas grid, accounting for group padding; zooming preserves alignment.
Previously saved free positions display at their nearest grid points. Positions are saved on drop in
`ephor_service_map_position`, independently by service and component, and loaded
with service summaries on every browser/device. Per-card revisions prevent late
refreshes from overwriting newer positions. Saves are serialized per card and
coalesce repeated drops to the latest destination; independent cards save concurrently.
Drag rendering is limited to one update per animation frame. Failed saves retain the local
position and show a Retry action. No service restart or browser storage is needed.

Groups are always expanded. The group header has a name and a menu button for
editing its name and accent color. These settings persist in the database and
are independent of the primary service name. Every service and dependency drawer
has a pencil control for changing its display name without changing runtime
component IDs, domains, environment references, deployment recipes, or data.
Presentation edits require an authenticated owner and same-origin requests; they
do not restart services or require an infrastructure-action passkey. Resource totals in the group header describe
the whole app; cards and component metric views only show their own measurements.
App status remains visible when a dependency fails, alongside the group name.
Stale reports do not display live usage. Primary identity comes from the same
pinned recipe ordering the worker uses for its main endpoint, exposed explicitly
in topology metadata; it is not guessed from the component name.

Arrows point from a consumer to its dependency. Dependencies are explicit,
versioned metadata in `packages/api/src/services/topology.ts`, separate from the
immutable deployment recipes. For example, Umami's `web` component uses
`database` through `DATABASE_URL`. Shared variable values are never compared to
infer edges, and an app secret is not treated as a secret owned by its database.

Component variables show the environment assembled by the installed recipe,
including literal template values and references to generated app secrets. They
are read-only, masked by default, searchable, and can be revealed or copied with
a fresh owner passkey. The resolved values are excluded from ordinary service
reads; reveals are audited. Switching away from the variables view clears revealed
values. Template configuration remains immutable.

Deployments, restart/stop, recovery points, offsite backups, and restore remain
app operations, accessed from the primary card. “Stop app” and “Start / restart
app” affect every component, with the scope stated in the main drawer. Dependency
drawers have no domain or independent lifecycle controls. Their persistent mount
paths identify storage included in the app backup. Shared app credentials remain
available under “Setup & data → App access & shared secrets”.

Apply migrations `0013_component_metrics.sql`, `0014_service_presentation.sql`,
`0015_service_map_positions.sql`, and `0016_map_position_revisions.sql`
when updating the API. Missing the metrics table causes history and retention
queries to fail, including app history. New workers
include independent component metrics and bounded, redacted log tails in their
existing runtime reports. Component history is stored separately by app and
component, sampled once per minute and retained for 24 hours. Existing workers
remain compatible: component status is still available, while drawers explain
that upgrading the worker is required for component metrics and logs. History
starts when the updated worker first reports; app totals are never substituted
for missing component measurements. No recipe or deployed container rebuild is
required for this telemetry change.

## Deploy

1. Upgrade the deployment worker from **Services → Connections** on the destination
   machine. Catalog deployments require **service protocol 3** and Docker Engine 28
   or newer. The panel never sends catalog jobs to older workers.
2. Open **Services → Deploy service → App catalog**, choose an app and machine,
   and give it a name. Web apps require a domain; apex domains and subdomains work.
3. Point DNS at the machine and allow inbound TCP 80/443. Ephor manages HTTPS.
4. Deploy and confirm your passkey. The service page shows progress and container
   health. **Setup & data → Reveal credentials** requires another fresh passkey.
5. Web apps start behind a generated HTTP Basic access password at the proxy.
   Username is `admin`; use `ACCESS_PASSWORD` from the credential view. Complete
   the application's own setup. For Umami, replace its initial `admin` / `umami`
   password. Only then choose **Publish after setup**. Ephor takes a recovery point and restarts
   the app to apply the setting. Do not remove protection while an installer is unclaimed.

Database-only templates expose an allocated port on **127.0.0.1 only**, without
public TCP ports or a domain. The service page provides an SSH-forwarding example.
PostgreSQL uses database `app`, username `ephor`, and generated `DB_PASSWORD`.
Redis uses `DB_PASSWORD` and AOF persistence with `appendfsync everysec` (up to a
second of writes can be lost on power failure). Catalog dependency databases are
accessible to the app through its private Docker network and have no published ports.
Custom services can join standalone database networks using Variables → Connect a
service. Connections are limited to the same machine and require protocol 5
(protocol 6 for Qdrant).

### Qdrant and database sizing

Qdrant requires protocol 6. Its pinned multi-architecture image runs as UID 1000,
stores collections and snapshots under `/qdrant/storage`, and checks `/readyz`
before becoming ready. HTTP is available through the allocated loopback port;
HTTP 6333 and gRPC 6334 are available inside the private service network. There
is no public database endpoint. Connect an app with `QDRANT_URL`,
`QDRANT_GRPC_URL`, and `QDRANT_API_KEY` references. The generated key is masked
and requires a fresh passkey to reveal. Send it as the Qdrant `api-key` header
or the corresponding client SDK option.

Standalone PostgreSQL, Redis and Qdrant offer **Setup & data → Database resources**.
Save memory and CPU limits, then explicitly restart to apply them. The restart
takes a cold recovery point and interrupts connections; saving alone changes no
running container. Redis also requires a data-memory limit no greater than 75%
of container memory, leaving headroom for process overhead. These overrides require
protocol 6 and do not alter the pinned recipe or automatically tune PostgreSQL.
The worker checks available host memory but does not reserve fleet capacity.

## Persistent data and lifecycle

Volumes use Docker's local driver, no driver options, and names derived from the
service ID and a generation ID. Every network, volume, and container is checked for
Ephor ownership and service identity. App-provided host mounts, devices, Docker
sockets, arbitrary commands, and Compose YAML are never accepted. The worker
refuses to recreate a missing volume once an app has been provisioned.

Dependency containers start first and must pass template-defined health checks
before their dependants start. All components must be healthy before Caddy exposes
the site. Existing ordinary stateless services keep their rolling deployment path.
Catalog apps use **stop/start maintenance windows**, including backup and restore.
They do not promise zero downtime. Containers normally restart independently of
the panel. The worker disables their restart policies before a stateful operation
so a host reboot cannot restart a writer during restore.

Images are pinned to upstream multi-architecture SHA-256 digests. Restarting does
not pull a newer tag or migrate the database to another version. Existing recipes
are immutable. Generic configuration editing and image rollback are blocked.
In-place template upgrades and major-version database migration are intentionally
not automated; they require a separately reviewed migration path and restore plan.
Do not change a deployed recipe in place to force an upgrade.

All components have memory, CPU, process and log limits, a read-only root filesystem,
and bounded writable tmpfs locations. Most run non-root with all capabilities
dropped. The reviewed WordPress Apache recipe initializes as root with only
CHOWN, DAC_OVERRIDE, SETUID, SETGID and NET_BIND_SERVICE; Apache drops worker
privileges. It has no host mounts or Docker socket. Container isolation shares the
host kernel and is intended for trusted owner-managed workloads.

## Recovery points

**Create recovery point** removes public routing, disables restart policies, stops
components in reverse dependency order, and archives every data volume while
writers are stopped. A completed snapshot is offered only after all archive and
SHA-256 checks succeed and its manifest is persisted. Archives are uncompressed,
stored in separate Docker volumes, and never mounted into app containers. Storage
helpers run without networking or host mounts. Capacity checks reserve 1 GiB of
headroom; failures leave data intact and the app may remain stopped.

A restart of a provisioned app takes a recovery point first. **Restore** first
snapshots current data, verifies the selected archives, extracts them into new
volumes, then starts the same pinned application images against those volumes.
Original volumes remain on disk. The selected snapshot is never modified. The
restore changes the app's visible data back to that point in time; later writes
remain only in the retained original data and pre-restore recovery point.

Up to 20 completed recovery points are retained. There is no silent pruning.
Deleting a recovery point requires a fresh passkey and explicit UI confirmation;
it removes only that snapshot's volumes. A crash during deletion can leave orphaned
snapshot volumes, but cannot leave a partial snapshot in the restore list.
Incomplete backup/restore volumes and superseded original data volumes are kept
for administrator inspection. They consume space; monitor disk capacity. App
uninstallation and automatic volume deletion are not offered.

The root-only worker state/journal is persisted before mutations. After an
interruption, Ephor stops storage helpers and affected app containers, removes
public routing, marks recovery required, and waits for an explicit resume/restore.
It never automatically runs an old application image against possibly migrated
data. Download or validation failures before mutation leave an existing app online.

These are **same-machine recovery points**, not disaster-recovery backups. A lost
VPS or disk also loses these copies. Keep an encrypted off-machine backup of the
Docker data volumes, backup volumes, `/var/lib/ephor-services/state.json`,
`/etc/ephor/services.json`, and the panel database plus `BETTER_AUTH_SECRET`.
Follow your storage provider's documented consistent backup process; copying live
Docker volume directories is not a substitute for a stopped-app snapshot.
Use [off-site backups](backups.md) for encrypted Restic/S3 copies, daily or weekly
schedules, and restore into a new service on a replacement VPS. Remote retention
cleanup and recovery-kit import into a new panel remain manual.

## Secrets and access

Generated credentials have 256 bits of entropy. Service configuration and queued
job snapshots use the existing authenticated encryption with record-bound keys.
List/details endpoints expose variable names only. Credential reveal is a POST
requiring owner authentication, fresh passkey and exact origin, returns `no-store`,
and is audited. The UI hides revealed credentials after one minute. Worker logs
are redacted against the generated values. Root administrators can inspect Docker
environments and local worker state; filesystem and VPS access must be protected.
The Basic access gate stores a bcrypt hash in Caddy configuration.

The panel only exposes the reviewed template selector. Shell snippets in recipes
are fixed, reviewed source; secrets are environment values and are never interpolated
into host shell commands. The worker independently validates the template version,
image identity and allowed credential keys. It rejects changes to a provisioned
recipe's content hash or credentials, avoiding accidental replacement of initialized
database credentials. Routes and all lifecycle actions remain owner-only.

## Development and releases

Apply `0009_catalog.sql` for PostgreSQL or D1. Run `bun run bundle:daemon` to produce
both Linux architecture assets; the bundle manifest advertises `serviceProtocol: 3`.
The catalog file is part of the build fingerprint and Docker build context.
Upgrade the separate deployment worker using its setup command. Monitoring-daemon
updates alone do not replace it. Do not downgrade workers after creating catalog apps.

Recipes live in `packages/api/src/services/catalog/templates.json`. Add a new
revision instead of altering an existing revision. Retain old revisions in the
compiled catalog so existing machines can operate their installed apps. The panel
shows the highest revision per app; deployed apps retain their selected revision.
Verify publisher provenance, amd64/arm64 image manifests, every writable directory,
least privilege, startup dependencies, health checks, generated secrets, and a real
backup/restore before accepting a recipe. Pin images by digest, never mutable tags.

Validation commands:

```sh
bun run lint
bun run typecheck
bun test packages/api/test/catalog.test.ts packages/api/test/services.test.ts packages/api/test/github-app.test.ts
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
bun run test:services:linux
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL instance to run API tests against
PostgreSQL as well as the default SQLite fixtures. The Linux suite uses a disposable
nested Docker engine, never the developer's Docker socket. The catalog test deploys
each recipe, checks private connections and setup protection, writes persistent data,
backs up/restores, restarts, simulates an interrupted operation, and checks explicit
recovery. It also verifies that damaged archives cannot replace current data and
that missing data volumes are never silently recreated. The
suite uses a local Caddy test CA; public DNS/ACME remains deployment-specific.

Upstream references: [Docker volumes](https://docs.docker.com/engine/storage/volumes/),
[PostgreSQL entrypoint](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh),
[WordPress entrypoint](https://github.com/docker-library/wordpress/blob/master/docker-entrypoint.sh),
[Umami installation](https://docs.umami.is/docs/install).
