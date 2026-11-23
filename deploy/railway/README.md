# Railway

Use the [release installer](../../docs/panel-updates.md#railway) with a project
token for the intended environment. It creates PostgreSQL, the official Ephor
image service, persistent volumes, private database networking, and an HTTPS
domain. No GitHub repository or source build is required.

The panel requires a persistent volume mounted at `/data` for pre-migration
backups. The official image starts with `bun apps/server/dist/index.js`, runs
migrations before listening, and serves the dashboard and `/api` on `$PORT`.
Use `/health` as the health check. Preserve `DATABASE_URL`, `EPHOR_ORIGIN`,
`BETTER_AUTH_SECRET`, and `EPHOR_SETUP_CODE`; never put secrets in `VITE_` variables.

The installer connects updates automatically. For adoption, open **Updates →
Hosting setup** and provide the service ID, environment ID, and project token.
The backend validates these against the service's Railway runtime identity.
See [existing installations and recovery](../../docs/panel-updates.md#existing-source-installations).
