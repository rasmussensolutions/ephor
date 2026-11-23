# Docker / VPS

Use the [release installer](../../docs/panel-updates.md#docker--vps) on a Linux
host with Docker Engine, Compose v2, Node.js 22+, and systemd. It installs the
official image by digest, private PostgreSQL, and the host updater. Point an HTTPS
reverse proxy at `127.0.0.1:3002` and enroll using the printed setup code.

Updates are approved in Ephor's **Updates** page. The host updater verifies the
signed release independently and replaces the panel. The web application runs
unprivileged with a read-only root filesystem and never receives a Docker socket.

Configuration is private under `/var/lib/ephor`; database backups are under
`/var/lib/ephor/data/backups`. Preserve both the database and authentication secret.
See [adoption and recovery](../../docs/panel-updates.md#existing-source-installations)
for existing Compose deployments.

`Dockerfile` is used by the official release pipeline. `compose.yaml` is a
reference for custom operators; set `EPHOR_PANEL_IMAGE` to a verified release's
immutable digest. Custom Compose installations must arrange their own updater
or adopt the managed layout. Building from source is a development workflow.
