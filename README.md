# Ephor

A server-management panel for machines and the services running on them.

[Connect an AI agent](docs/mcp.md) through the built-in remote MCP endpoint, with
project-scoped credentials, write-only secrets, and passkey-approved changes.

Install an official release on **Cloudflare Workers**, **Railway**, or **Docker/VPS**.
No fork, repository copy, or host-side build is required. The installer connects
updates once; afterward use **Updates → Update** in the panel.

For a fresh VPS, point a domain at the server and run this over SSH:

```sh
curl -fsSL --proto '=https' https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/install.sh | sudo sh -s -- vps --domain=panel.example.com
```

The installer sets up Docker, the panel, its database, automatic HTTPS and the
panel updater. No Node.js or manual proxy configuration is needed on the VPS.
Ubuntu 22.04/24.04/26.04 and Debian 12/13 are supported for automatic setup;
allow inbound ports 80 and 443 in your provider's firewall.

For Cloudflare or Railway, run the wizard on your own computer (Node.js 22+):

```sh
curl -fL --proto '=https' https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/install.sh -o install-ephor.sh
sh install-ephor.sh cloudflare  # or railway
```

See the [installation guide](docs/panel-updates.md#install) for prerequisites,
provider tokens, and adopting an existing installation. Cloudflare remains a native
Worker; it does not need a container.

The dashboard includes passkey authentication, deployment-controlled owner setup,
recovery codes, session management, and security activity. The shared API runs on
Bun/Node with PostgreSQL or Cloudflare Workers with D1. The Rust daemon supports
secure machine enrollment and live CPU, memory, and disk usage. Services support
container images, GitHub App connections with automatic Dockerfile/Railpack builds,
push deployments without workflow files, root and subdomain HTTPS routing, health checks,
logs, and rollback. See [service deployment](docs/services.md) for setup and scope.
The [app catalog](docs/catalog.md) provides reviewed PostgreSQL, Redis, Uptime Kuma,
WordPress, and Umami deployments with persistent storage, private multi-container
dependencies, protected setup, and local recovery points.
[Off-site backups](docs/backups.md) add encrypted Restic/S3 storage, schedules,
recovery-kit export, and restore into a separate service on another machine.

## Local development requirements

- Bun **1.3.14** (package manager, workspace scripts, and local API development)
- Node.js **22.12+**; **24.12.0** is pinned for development and CI
- Rust **1.85+** with Cargo, rustfmt, and Clippy (only needed for daemon work)

Use Bun for JavaScript dependencies. Commit `bun.lock` and `Cargo.lock`.

## Getting started

```sh
bun install
# Configure apps/server/.env using its example and create a PostgreSQL database.
bun --env-file=apps/server/.env run auth:admin migrate
bun --env-file=apps/server/.env run auth:admin setup
bun run dev
```

| App                        | Local URL                    | Run separately          |
| -------------------------- | ---------------------------- | ----------------------- |
| Dashboard                  | http://localhost:3000        | `bun run dev:dashboard` |
| Landing page               | http://localhost:3001        | `bun run dev:website`   |
| Node.js-compatible API     | http://localhost:3002/health | `bun run dev:server`    |
| Cloudflare API alternative | http://localhost:8787/health | `bun run dev:worker`    |

The default `dev` command starts the two frontends and the conventional API.
The dashboard proxies `/api` to the API; open the dashboard origin to enroll and
sign in. Follow [authentication setup](docs/authentication.md) for the required
secrets, first-owner flow, and recovery. Never put secrets in `VITE_` variables.

For local Workers/D1 and production hosting, see `deploy/cloudflare`,
`deploy/docker`, and `deploy/railway`. The daemon is not started by `dev`.

## Repository layout

```text
apps/
  dashboard/          TanStack Start + React; management pages and navigation
  website/            TanStack Start + React; public landing page
  server/             Node.js API entry point; developed with Bun
  worker/             Cloudflare Workers API entry point
  daemon/             Rust binary: ephord
packages/
  api/                Shared, runtime-independent HTTP routes
  ui/                 Shared React primitives and base styles
  typescript-config/  Shared strict TypeScript configurations
deploy/
  docker/             Conventional deployment notes
  railway/            Railway deployment notes
  cloudflare/         Cloudflare deployment notes
docs/
  architecture.md     Boundaries and intended hosting model
.github/workflows/    Build and quality checks
Cargo.toml            Rust workspace
package.json          Bun workspace and root scripts
```

## Development commands

```sh
bun run build          # Frontend bundles, Node bundle, Worker dry-run bundle
bun run typecheck      # All TypeScript packages; generates Worker types locally
bun run lint           # Biome lint, formatting, and import checks
bun run format         # Apply Biome formatting and safe fixes
bun run test           # Authentication and machine enrollment/security tests
bun run check          # Lint, TypeScript, auth tests, Rust formatting and Clippy
bun run check:daemon   # Rust formatting and Clippy only
bun run build:daemon   # Release daemon binary in target/release/ephord
cargo run -p ephord -- sample # Print one real host metrics snapshot
bun run bundle:daemon  # Build Linux installer artifacts (requires Docker)
```

TanStack generates `src/routeTree.gen.ts` in each frontend. These files are
committed so a clean checkout can be typechecked before running a dev server.
After adding or renaming routes, run that app's dev server or build to regenerate
its route tree. Do not edit generated route trees by hand.

Wrangler generates `apps/worker/worker-configuration.d.ts` from `wrangler.jsonc`.
It is generated during typechecking and is not committed.

Shared TypeScript packages export source directly; the consuming app bundles
them. They do not require their own compilation step. Keep dependencies in the
workspace that imports them and use `workspace:*` for internal dependencies.

## Dashboard UI

The dashboard uses shadcn/ui (Base UI, Nova style), Phosphor icons, and Tailwind CSS v4. Its
configuration lives in `apps/dashboard/components.json`; owned component source
lives in `apps/dashboard/src/components/ui`. `AppSidebar` composes those
primitives with TanStack Router links, organized into these groups:

- Main: Home, Activity, Ask AI
- Servers: Machines, Services, Projects, Updates
- Operations: Monitors, Logs, Backups, Workflows, Fixes

Machines, Security, sign-in, setup, and recovery are implemented. The remaining
infrastructure pages are empty shells. See [connecting machines](docs/machines.md)
for enrollment and deployment instructions. All dashboard routes require a valid owner session.

Add another component from the repository root:

```sh
bunx --bun shadcn@latest add <component> -c apps/dashboard
```

Theme variables and dashboard styles live in `apps/dashboard/src/styles.css`.
The sidebar collapses to icons on desktop (button or Cmd/Ctrl+B), and uses a
drawer on mobile. Selecting a navigation link closes the mobile drawer.

## Hosting status

The dashboard builds as a private SPA, served with the API on one origin. The
conventional distribution serves the same assets on Bun/Node; the Worker uses
Workers Static Assets and D1. Docker Compose configuration and Railway instructions
are included. The public landing page remains independent. `bun run build` does
not publish or provision anything.

See [architecture](docs/architecture.md) and the notes in `deploy/` for the intended
hosting options. The project is intended for an open-source release; a license
must be chosen before that release.

## Panel updates

Use **Updates** to check and install signed, tested releases. Docker's host updater,
Railway's deployment API, and Cloudflare's Worker API install the correct artifact
for your host. Database recovery points precede migrations; success is confirmed
by the running version. See [panel updates and recovery](docs/panel-updates.md).

## Daemon releases and updates

Ephor's machine roles share one installed executable and version, with separate service permissions. **Machine → Maintenance** handles setup, repair and signed updates with manual (default), automatic-when-idle or pinned-version policies. Existing machines migrate once using a generated command. See [docs/updates.md](docs/updates.md) for release prerequisites and recovery. Panel hosting can remain on Workers, Railway, Docker or a VPS.

[Notifications](docs/notifications.md) add an in-app inbox, optional Resend email, event preferences, and delivery history.
