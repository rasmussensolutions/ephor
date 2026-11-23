# Services

Ephor runs multiple HTTP applications and reviewed stateful catalog apps on an enrolled Linux machine. See [App catalog](catalog.md) for persistent storage, private multi-container apps, and recovery points. Deploy an existing container image, or connect GitHub and let Ephor build with a Dockerfile or automatic framework detection using Railpack. Repository files are never modified. Pushes to the selected branch queue new builds automatically.

## First deployment

1. Open **Machines → Add machine** and run the enrollment command. It installs monitoring and the deployment worker together, with Docker Engine 28+, Buildx, Git, and a checksummed Railpack executable. Ubuntu and Debian support automatic dependency installation; other systemd Linux distributions need those tools preinstalled. Existing Docker installations are checked and preserved.
2. For an older machine or an interrupted install, open **Machines → your machine → Settings → Deployments** and get a setup, update, or repair command. Confirm your passkey and run it on that machine within ten minutes. Monitoring stays unprivileged; the separate root-owned worker manages deployments and keeps its identity and running applications when updated.
3. For repositories, open **Settings → Integrations → GitHub**. On the first connection, GitHub guides you through creating a GitHub App owned by you for this Ephor instance. Return to Ephor and finish connecting, then install it on your account or organization with access to **only selected repositories**. No personal access token, manually copied key, or workflow commit is needed. Organization policy may require an administrator to approve the installation.
4. Open **Services → Deploy service**. Choose a repository and production branch, or an existing full image reference. Select its destination machine. The default build runs on that same VPS; no registry is needed.
5. Enter a root domain or subdomain if the app should be public, runtime variables, application port, and health path. Advanced settings cover project directory for monorepos, Dockerfile/Railpack selection, build resources, build-only variables, private image credentials, and an optional separate build machine.
6. Review and **Deploy service**, then confirm with your passkey. If the worker needs setup, Ephor saves your service settings and explains how to enable it. Once connected, choose Deploy. Follow build logs, deployment history, health, and runtime logs in Details.

The first GitHub connection requires a stable, publicly reachable HTTPS panel address. For local development, keep `bun run dev:tunnel` running at your configured stable domain. Self-hosters own their App and its installations; there is no Ephor cloud account or shared GitHub credential. The App is installable on other accounts so organizations work too; **Ephor only accepts installations explicitly connected by its authenticated owner**. The App asks for read-only repository contents/metadata and push events, without workflow or repository write permission.

The app must listen on `0.0.0.0` on the configured port (1024–65535), run as numeric UID/GID **65532**, and return **HTTP 2xx** from its health path. Ephor supplies `PORT` and `HOST=0.0.0.0` unless explicitly configured. The root filesystem is read-only and `/tmp` is writable but bounded. Use external databases/object storage for durable data. Images requiring root, arbitrary host mounts, or writes elsewhere will fail safely. Automatic framework detection does not guarantee every framework works with these runtime restrictions; a custom Dockerfile is available when adaptation is needed.

## Custom domains and HTTPS

You can use **any root domain or subdomain you control**, including multiple unrelated domains on one service. Add up to nine aliases, and choose whether they serve the app or redirect to the primary hostname. Redirects use HTTPS 308 and preserve paths and query strings. Wildcard domains are not supported.

Set an **A** record for each hostname to the VPS IPv4 address. Only add **AAAA** when that IPv6 address reaches the same VPS. For a root domain, DNS providers commonly use `@` as the record name; for `www.example.com`, use `www`. The Details page shows reported machine addresses and checks public A/AAAA records. Ephor works with any DNS provider and does not require DNS account credentials.

Allow inbound **TCP 80 and 443** in the provider and host firewalls. Caddy owns these ports and routes hostnames to loopback-only application ports. Existing nginx/Apache/other listeners must be moved deliberately by the operator; Ephor does not stop or replace them. Its administration API is a root-private Unix socket, not a public port. ACME certificates renew automatically; the `ephor-caddy-data` Docker volume persists certificate state. Back it up with the machine.

A healthy deployment verifies the local app, **not external DNS or certificate readiness**. DNS changes and certificate issuance can take time. Cloudflare proxy addresses will not match the machine's addresses; start with DNS-only records and use Full (strict) if you later enable proxying. A service without a domain is private on `127.0.0.1` with an assigned port visible to local administration.

Domain changes apply on the next deployment. Reservations are kept even after removing a hostname so a failed/queued rollout or rollback cannot accidentally transfer a live route to another service. Moving hostnames between services currently requires an administrator to reconcile the old route and reservation deliberately. Raw TCP exposure and wildcard certificates are not implemented.

## Connecting an app to a database

Open the app's **Variables** tab. **Connect a service** suggests `DATABASE_URL`
for standalone PostgreSQL catalog services and `REDIS_URL` for Redis on the same
machine. Qdrant offers `QDRANT_URL`, `QDRANT_GRPC_URL` and `QDRANT_API_KEY`.
Select **Add**, save the variables, then deploy the app. Deploy the
database first. If the suggested variable name already exists, choose another
name; suggestions never silently replace existing values. The variable editor
also lets you select a service connection for an existing variable.

Saving immediately adds a dashed arrow from the app to its database on the machine
canvas. These arrows represent saved connections, not a live connectivity test.
The **Changes need deployment** notice and **Deploy changes** button remain visible
until a successful deployment matches the saved runtime variables and connections.
For repository services this uses the existing rebuild-and-deploy flow. Saving
alone does not restart the app; a failed or older deployment does not clear newer
pending changes.

Links are stored as whole-value references such as
`${{<service-id>.DATABASE_URL}}`. Names can change without breaking links. The
raw editor, reveal, and copy preserve the reference; the database password is
not copied into the browser. Ephor resolves references into private connection
URLs when queuing a deployment or repository build, encrypts that snapshot, and
joins the app to the selected database's network. Runtime credentials are never
sent to the builder. This uses [Docker's private bridge networking and container
DNS](https://docs.docker.com/engine/network/drivers/bridge/); database ports remain
bound to loopback on the host.

Update the machine's deployment worker to protocol **5** before deploying an app
with PostgreSQL/Redis connections, or **6** for Qdrant connections and custom
persistent services. Older workers cannot claim these deployments. Removing a link
and deploying removes that network attachment from the new app container. Saved
changes do not restart running services. Rollbacks retain their original resolved
credentials and connections; future deployments resolve the current source
configuration. Missing or unsupported sources fail deployment instead of leaving
an unresolved placeholder. Cross-machine links and databases embedded inside
another catalog app are not offered.

## Builds and automatic deployment

**Automatic** uses a Dockerfile when present in the selected project directory; otherwise Railpack detects the framework. You can explicitly select either method. A Dockerfile path is relative to the project directory. Each service can select a different directory in the same repository.

GitHub sends an HMAC-signed webhook. Ephor binds it to the approved installation, numeric repository identity, and selected branch, then stores an encrypted build snapshot. Duplicate deliveries are idempotent. Only branch pushes trigger production builds; PR/fork previews and arbitrary branches do not. The worker obtains a short-lived, repository-scoped read token when claiming the build. Source fetching uses a fixed GitHub HTTPS origin, checks out the exact commit, and removes Git credentials and `.git` before building. Git submodules and Git LFS downloads are not enabled.

One build runs per build machine. Queued automatic builds whose commits are no longer the branch head are skipped. Delivery time is never treated as commit order, so a delayed old webhook cannot discard a newer commit. Before starting and before queuing deployment, Ephor rechecks the branch head and connection; obsolete, cancelled, or disconnected builds cannot replace production. Changing repository/branch invalidates old builds. Pausing automatic deployment prevents queued/running automatic builds from being promoted, but an already queued deployment must be cancelled separately. Manual Deploy intentionally allows rebuilding the selected commit snapshot.

Build logs and progress appear in Ephor. Cancel stops the build at its next progress check. Interrupted workers reconcile a persisted receipt rather than reporting a partial image as successful. Builds time out after twenty minutes; progress is checked approximately every ten seconds. Only a successful immutable image reference enters the deployment queue.

Runtime variables are never passed to the builder. Build variables are a separate encrypted set. Dockerfiles use BuildKit secret mounts, for example `RUN --mount=type=secret,id=TOKEN ...`; Railpack receives the corresponding build variables through its plan and secret mounts. Repository code can read build variables, and values embedded into browser bundles become public. Leave variable fields empty when editing to keep existing values; use `{}` to clear all, or enter a complete replacement.

Local builds load images directly into the destination Docker engine and pin their image IDs, verified against Ephor's service-specific image namespace. Keep these images for rollback; deleting them prevents rollback to that version. BuildKit containers, planner containers, temporary credentials, and checkouts are removed after completion/cancellation. Build images are retained and use disk space; monitor capacity and remove unneeded historical images deliberately. Builds refuse to start with less than 5 GiB available and abort if free space falls below 2 GiB.

The default build budget is 512 MiB / 1 CPU in the wizard, with at least 256 MiB additional free memory required. Real applications may need more. A small 1 GiB VPS may not have enough headroom for a production app plus a build and deployment candidate. Increase resources or use a dedicated build machine.

### Optional dedicated build machine

Enable the deployment worker on the build machine too; both machines must have the same architecture. Configure a private registry namespace in **Settings → Integrations**, with separate push and pull-only credentials. Select the build machine in service Settings. Only the builder receives the push credential; only the destination receives the pull credential. The built registry manifest digest is pinned for deployment. No registry is required when building and running on the same machine.

### Existing GitHub Actions services

The previous workflow/OIDC endpoints remain for existing services. New connections use the GitHub App and never write a workflow file. To migrate an existing service, edit its Source, select the installation/repository/branch, and remove its old deployment workflow yourself. Existing legacy workflows can still submit deployments until removed. Their OIDC signature, repository/owner identity, workflow, audience, branch, and run-order checks remain enforced.

GitHub does not automatically redeliver every failed webhook. If the panel/tunnel is unavailable during a push, redeliver the event in GitHub or click Deploy after the panel returns. GitLab/Bitbucket, PR preview environments, arbitrary Compose files, and a hosted shared builder are outside this implementation.

## Uptime and failure behavior

The worker pulls and pins the image, starts a candidate beside the current container, and requires three successful HTTP health checks within 90 seconds. Only then does it reload all Caddy routes atomically. The old container gets a drain interval and graceful shutdown; a previous revision is retained. The machine needs capacity for the old and new containers plus the proxy during deployment. The worker checks available memory before launching a candidate and reserves 128 MiB of headroom; this is a preflight check, not fleet-wide resource reservation. HTTP health is a readiness check, not proof of application correctness.

The worker persists a root-only journal before changes. On an interrupted operation it restores the previous route/container before accepting another job. A terminal receipt is retried until the panel acknowledges it. Jobs are serialized per machine and per service. Queued jobs expire after one hour; claimed jobs never expire automatically and race a potentially live worker. If a machine disappears mid-deployment, repair the worker on the same machine so it can reconcile its journal. Do not manually erase the journal to clear a stuck job.

Containers restart independently of the panel or worker. Panel/tunnel outages therefore do not stop services. Container restarts, host outages, and long-lived WebSocket/stream connections can still interrupt requests. This is single-machine deployment, not multi-node high availability. A later readiness failure is reported as unhealthy; it does not automatically roll back potentially legitimate application state changes. Docker restart policy restarts exited processes.

Reviewed catalog apps support persistent volumes, private databases, and multi-container startup. Custom image/repository services can also use managed persistent volumes (below). Arbitrary background workers, one-off migrations, and automatic database rollback remain outside this implementation. Use backward-compatible migrations. Rolling back application code cannot undo a schema/data change.

### Custom persistent services

In service creation, enter up to four named mounts, one per line, for example
`data=/data`. The worker creates owned Docker volumes; host bind mounts, Docker
sockets, system paths, overlapping paths and driver options are rejected. Mount
layouts become immutable once a deployment is queued. Create a separate service
and migrate data to change a layout or convert an already deployed stateless app.
Containers run as UID/GID 65532 with a read-only root filesystem, writable `/tmp`,
and owned data directories; images must work with these restrictions and expose
an HTTP readiness endpoint. Configure `PORT` or the image's native settings as
needed. Arbitrary entrypoint/command and user overrides are not supported.

These services require protocol 6 and use stop/start maintenance windows. Each
redeploy stops the existing writer cleanly and snapshots its data before starting
the new image on the same volumes. There are never intentionally two application
writers. Failed/interrupted operations retain data and require explicit recovery;
missing provisioned volumes are never silently recreated. Ordinary stateless apps
keep rolling deployments. Do not enable automatic deployments if you cannot accept
these maintenance windows or application-owned schema migrations.

**Setup & data** exposes stop/start, cold recovery points and restore. Code-only
rollback is blocked. A local recovery point can be restored only with its matching
image and environment; after changing either, use a compatible offsite backup to
restore a separate service. Data restore uses new volumes and keeps the originals.
Monitor disk space: retained recovery points and original volumes consume storage.
For encrypted scheduled backups and source-machine-loss recovery see
[Off-site backups](backups.md).

## Secrets and isolation

Environment variables and registry tokens are AES-GCM encrypted in the database, using a domain-separated key derived from `BETTER_AUTH_SECRET` with per-record associated data. Back up that secret with the database. Rotating it without re-encrypting service records makes existing records unreadable. Lists and histories expose only environment names, never their values. Deployment snapshots retain encrypted secrets for reproducible rollback.

A dedicated deployment credential can access only its own machine's jobs. Monitoring credentials cannot fetch service secrets. Revoking the machine blocks both credentials but leaves deployed workloads running. Owner mutations require a fresh passkey and same-origin JSON. GitHub App private keys, webhook secrets, registry credentials, and build snapshots use the same encrypted store. Disconnect cancels pending builds and removes the local App credentials; revoke the installation in GitHub as well when retiring it. Deployment reports only accept defined error codes, avoiding accidental command-output leakage.

The worker is privileged because Docker access is privileged. It accepts a strict typed specification, passes no application data through a shell, and creates containers through the local Docker Unix API. Application environment values never enter a host process environment. Containers get a non-root user, dropped capabilities, no-new-privileges, a read-only root filesystem, CPU/memory/PID limits, bounded logs, no host mounts/devices/socket, and their own bridge networks. Images' own healthcheck commands are not relied upon; readiness probes go to a fixed loopback address and cannot redirect.

The Railpack planner runs non-root with a read-only source mount and no Docker socket. BuildKit uses a disposable, resource-limited Docker-container builder without insecure build entitlements. Docker build infrastructure itself is privileged, and container isolation is not a VM security boundary. Containers are appropriate for your trusted applications, not hostile multi-tenant workloads. Use a dedicated build machine for less-trusted repositories. They share the host kernel and retain outbound connectivity, including network access allowed by the VPS routing/firewall. Enforce egress restrictions separately where needed. Exact configured environment values are redacted from runtime log excerpts, but transformed/encoded secrets cannot be reliably detected. Applications must avoid logging them.

## Operations

- Worker status: `sudo systemctl status ephor-services`
- Worker logs: `sudo journalctl -u ephor-services -n 100 --no-pager`
- Proxy logs: `sudo docker logs --tail 100 ephor-proxy`
- Worker identity: `/etc/ephor/services.json` (root-only; never share its contents).
- Durable state/journal: `/var/lib/ephor-services/state.json` (root-only; includes application secrets).
- Proxy certificate storage: Docker volume `ephor-caddy-data`.

The helper is pinned separately at `/usr/local/libexec/ephor-services`; ordinary monitoring daemon updates do not replace it. Use the Services setup/upgrade command to replace it after backing up state. Existing configuration is preserved and the worker restarts. Avoid interrupting builds when possible; interrupted builds fail safely and can be retried. Running application containers continue through a worker restart.

## Development and validation

Run `bun run auth:admin migrate` with the server environment loaded (the `dev:tunnel` launcher applies migrations). Apply `0024_persistent_workloads.sql` on PostgreSQL or SQLite/D1 before using persistent backup jobs. Workers deployments apply the SQLite migrations through Wrangler. Build both architectures with `bun run bundle:daemon` before building/deploying the panel; the manifest must contain `serviceProtocol: 6` for the new features. Upgrade each machine's deployment helper from Settings → Deployments. Monitoring-daemon updates alone do not replace it. Older workers remain usable for compatible existing jobs and cannot claim protocol-6 deployments or backups.

For a source-built Cloudflare panel, run `EPHOR_DAEMON_LOCAL=1 bun run build:cloudflare`
after bundling. This validates both local architecture checksums and protocol 6,
instead of overwriting them with the currently pinned public release. Without that
flag the template build intentionally uses the published release pin in
`scripts/download-daemon.ts`; new-feature upgrade commands fail closed if that
release is too old. Publishing a new immutable public daemon release and updating
that pin is a separate release operation. Local compilation does not publish it.

`bun test packages/api/test/services.test.ts packages/api/test/github-app.test.ts` covers browser/worker authorization, encrypted snapshots, per-machine isolation, queue transitions, cancellation, domain reservations, rollback, and GitHub OIDC signature/claims, App setup state, signed webhooks, scoped repository access, local/remote build credential separation, cancellation, supersession, and root/alias domain reservations. Repeat with `TEST_DATABASE_URL` for PostgreSQL. `cargo test --workspace` covers worker validation/config generation. The real Linux lifecycle test runs an isolated Docker-in-Docker engine, never the developer's Docker socket. Run `bun run test:services:linux`; it builds its fixture, exercises multiple services, TLS routing, failed readiness checks, restart-stable ports, crash recovery, uninterrupted requests during deployment/rollback, and stop. It also builds real Dockerfile and Railpack Node applications and runs them under production container restrictions, then removes the disposable engine. Real GitHub installation consent and public DNS/ACME issuance still require operator setup; fixtures do not grant third-party access.

## Upstream references

The container restrictions follow [Docker Engine security](https://docs.docker.com/engine/security/) and [container resource controls](https://docs.docker.com/reference/cli/docker/container/run/). HTTPS/routing use [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) and its [atomic configuration API](https://caddyserver.com/docs/api). GitHub setup uses the [App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Automatic builds use [Railpack's production frontend](https://railpack.com/platforms/buildkit-frontend/).

### Service monitoring

Machine → Services opens a dotted-grid map. Select a service card to open its drawer
without leaving the map; closing it preserves the canvas position. The drawer shares
Deployments, Variables, Metrics, Logs, Domains, and configuration with the service page.
Use **Open page** for the standalone view, or the Cards toggle for the original grid.

The Variables tab manages runtime variables with search, masked values, explicit reveal
and copy, and staged additions, replacements, and removals. Save variables, then deploy
to apply them. The raw editor accepts literal `.env` entries (including quoted multiline
values) or a JSON object of strings; it replaces the complete runtime set, so omitted
names are removed. Build-only variables remain in repository configuration. Catalog
variables are read-only here and remain managed by their reviewed templates.

Ordinary reads return only names. Revealing values, opening the raw editor, and saving
require fresh owner passkey verification. Reveals and updates are audited without values;
responses are not cached. Variable updates compare the encrypted configuration revision
and reject stale edits instead of silently replacing newer settings. Drafts survive tab
changes and failed saves; closing a dirty drawer asks before discarding them.

Services now has a searchable table with status and machine filters, CPU/memory sorting,
and a dedicated `/services/<id>` page. Overview contains CPU, memory, uptime, process
count, restart count, and CPU/memory/network history. Deployments, Logs, and Settings
keep release controls, build output, environment configuration, and domain checks together.
GitHub and the build registry live in Settings → Integrations. Deployment readiness and repair commands live in each machine’s Settings.

Apply migration `0008_service_metrics.sql` before starting the updated panel. Existing
workers remain compatible but report no resource metrics until upgraded with the
setup/upgrade command in the machine’s Settings → Deployments. Upgrading the worker preserves its identity,
service state, and running containers. History starts when the new worker reports;
there is no historical backfill.

The worker reads Docker stats only for its managed active containers, independently
of builds. Reports arrive approximately every 30 seconds. CPU is a percentage of all
host cores (not the service's CPU quota); memory excludes inactive file cache, and
network values are bytes per second between samples. First samples and counter resets
have null CPU/network rates. Stale reports become unavailable after two minutes.

The database stores the latest received sample in each one-minute bucket. History is
limited to a rolling 24 hours with 15m/1h/6h/24h views (1/1/2/5-minute chart buckets).
Missing buckets are null rather than fabricated zeroes. Ingestion and history reads
prune expired samples; the server timer and Workers cron also prune every five minutes
when idle. Thus old samples are never returned after 24 hours and idle physical cleanup
can lag by up to five minutes while the panel is running. Worker payloads cannot choose
sample timestamps or write another machine's services. History requires owner sign-in.
