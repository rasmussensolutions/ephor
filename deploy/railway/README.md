# Railway

Use the conventional distribution with Railway PostgreSQL. Set the repository
root as the build context. No separate dashboard service is necessary.

- Build: `bun install --frozen-lockfile && bun run --filter @ephor/dashboard build && bun run --filter @ephor/server build`
- Pre-deploy: `bun apps/server/dist/auth.js migrate`
- Start: `node apps/server/dist/index.js` (or `bun apps/server/dist/index.js`)
- Health check: `/health`
- `DATABASE_URL`: reference the PostgreSQL service's private connection URL.
- `EPHOR_ORIGIN`: final public HTTPS origin, no trailing slash.
- `BETTER_AUTH_SECRET`: stable secret generated with `openssl rand -hex 32`.
- `HOST=0.0.0.0`
- `EPHOR_ASSETS_DIR=apps/dashboard/dist/client`
- `PORT`: provided by Railway.

Alternatively use `deploy/docker/Dockerfile` with the same variables and a
PostgreSQL service. The image uses Bun to run the Node-compatible bundle.

Once deployed, run `bun apps/server/dist/auth.js setup` inside the service's
runtime environment and use the one-use code on the dashboard. Generate and save
recovery codes after enrolling. Never put setup codes or auth secrets in frontend
variables. Run the `cleanup` administration command periodically, and configure
database backups. See [authentication](../../docs/authentication.md).

## Machine enrollment

Apply migration `0002_machines.sql` through the existing migration command. Before
building the dashboard, run `bun run bundle:daemon` on a build machine with Docker
and include the generated `apps/dashboard/public/daemon/` artifacts in your build
context/deployed assets. Git-only deployments do not include these gitignored
artifacts automatically. The panel must have a public HTTPS origin; `/api/*` and
`/daemon/*` must be reachable by the VPS. See [connecting machines](../../docs/machines.md).

## Panel updates

Open **Updates** in Ephor and connect its dedicated Updates GitHub App to the
repository that hosts this panel. Select your host and deployment method.
For a GitHub-connected Railway service with autodeploy enabled, select **My host
deploys GitHub pushes**. Use the repository default branch as the production
branch and configure the migration pre-deploy command above. Keep preview/PR
environments isolated from production data. Image-based or manually deployed
services should select **I deploy updates manually** instead.

Ephor separates repository progress from the version actually serving requests.
See the [panel update guide](../../docs/panel-updates.md) for the full review flow,
required GitHub permissions, and upgrading older installations.
