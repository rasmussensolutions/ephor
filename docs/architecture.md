# Architecture

## Applications

- `apps/dashboard` owns the management UI. It uses TanStack Start, TanStack Router,
  React, and Vite. Its Main, Servers, and Operations navigation groups lead to
  infrastructure pages. Owner authentication, security settings and machine
  enrollment/monitoring and service deployment are implemented.
- `apps/website` owns the public landing page. It uses the same frontend stack but
  has its own routes, metadata, styles, and deployment lifecycle.
- `apps/server` hosts the API in a conventional Node.js process. Bun runs the
  source during development and bundles it for Node.js in production.
- `apps/worker` hosts the same shared API in Cloudflare Workers.
- `apps/daemon` runs on managed Linux machines. It is a standalone Rust
  application, not a Worker and not part of the frontend runtime.

The two API entry points are alternatives for a panel installation. An
installation will not need to run both.

## Shared packages

- `@ephor/api`: HTTP route composition using Web Request/Response-compatible APIs.
  Node.js and Cloudflare infrastructure must remain outside this package.
- `@ephor/ui`: small, shared React components and CSS foundations. App-specific
  layouts stay in their respective apps. Components use explicit subpath exports.
- `@ephor/typescript-config`: strict compiler defaults shared by the workspaces.

When real business behavior is introduced, extract a `packages/core` package for
use cases and infrastructure interfaces. Add storage, job, and transport adapters
against actual requirements. Avoid speculative interfaces and empty packages.
Applications may import packages; packages must not import applications.

## Intended deployment model

| Concern                        | Conventional / Docker / Railway | Cloudflare                   |
| ------------------------------ | ------------------------------- | ---------------------------- |
| API runtime                    | Node.js server                  | Workers                      |
| Machine enrollment / telemetry | Outbound HTTPS + PostgreSQL     | Outbound HTTPS + D1          |
| Configuration and job records  | PostgreSQL                      | D1                           |
| Background work                | Durable job runner              | Queues / Workflows as needed |
| Private dashboard              | Static assets alongside API     | Workers Static Assets        |

The API, dashboard, authentication, enrollment/telemetry, signed daemon updates, and
service deployment queues are implemented. Jobs persist in PostgreSQL or D1 and
are polled by outbound workers on each VPS. No Cloudflare-specific queue or
always-running panel process is required.

The daemon initiates authenticated outbound HTTPS requests using the same versioned
telemetry payload across hosting modes. Enrollment uses short-lived one-use tokens
and per-machine bearer credentials stored as hashes. No persistent connection or
platform-specific gateway is required for monitoring. Deployment workers persist a local recovery journal, deduplicate deliveries, and
keep deployed services independent of panel availability.

## Current scope

The API provides health checks, owner authentication/security, and machine
enrollment/telemetry endpoints. The daemon installs as an unprivileged Linux service,
reports CPU/memory/disk snapshots, backs off on network failures, and stops when
revoked. A separately installed root-owned deployment worker manages isolated
Docker containers and Caddy routing through a fixed typed protocol. It has its
own credential and never accepts shell commands or host mounts. The Services
page supports images and GitHub App repository builds (Dockerfile/Railpack),
automatic branch-push deployments, root/alias HTTPS domains, encrypted
environment settings, logs, and rollback. See [connecting machines](machines.md)
and [services](services.md) for the supported workload constraints. Arbitrary
remote shells and infrastructure provisioning are not implemented.

The [app catalog](catalog.md) selects versioned recipes compiled into the worker.
Each app owns its networks, containers, and named data volumes. Stateful operations
use maintenance windows, a durable journal, and stopped-app recovery points.
Restore writes into new volumes and retains the previous data; ordinary image
rollback and unreviewed volume/command overrides are prohibited for catalog apps.

## Authentication implementation

The private dashboard uses TanStack Start SPA mode, with a shared same-origin API.
The server serves its static production assets, and the Worker serves the same
assets using Workers Static Assets. The public website retains its independent
TanStack Start setup. Authentication policy lives in `packages/api/src/auth`,
with PostgreSQL and D1 adapters supplied by the runtime entry points.

See [authentication](authentication.md) for the owner model, security invariants,
setup/recovery operations, storage migrations, and testing.

## Release distribution

Panel installs consume signed release artifacts, separately from daemon releases.
Docker and Railway use the same multi-platform image digest; Cloudflare uses the
prebuilt Worker and dashboard asset manifest. The update controller stores
encrypted provider configuration and leased, durable jobs in SQL. Provider
credentials never reach the client. Docker delegates deployment to a host timer
with an independently verified release ledger; no Docker socket enters the panel.
The server migrates under a PostgreSQL lock after a persistent backup; Worker
updates use D1 Time Travel and atomic migration batches. Only the compiled target
version can acknowledge completion. See [installation and recovery](panel-updates.md).
