# Cloudflare Workers

Install Ephor as a native Worker with D1 using the [release installer](../../docs/panel-updates.md#cloudflare-workers).
No repository copy, fork, build service, or Cloudflare Container is needed.
The installer creates the database, secrets, dashboard assets, and update schedule.
Future releases are installed from **Updates** in the panel.

Existing installations made with the old Deploy to Cloudflare button can use
`cloudflare --adopt`; see [adopting source installations](../../docs/panel-updates.md#existing-source-installations).
The existing owner, D1 database, authentication secret, and domain are retained.

## Developing from source

For development only, install dependencies, build dashboard assets, configure a
private Wrangler file with your account's D1 binding and exact `EPHOR_ORIGIN`,
and set `BETTER_AUTH_SECRET` and a separate `EPHOR_SETUP_CODE` using Wrangler
secrets. Keep private files out of Git. Apply migrations before deployment:

```sh
bun install --frozen-lockfile
bun run build:cloudflare
bun run --filter @ephor/worker exec:wrangler d1 migrations apply DB --remote --config /path/to/private-wrangler.jsonc
bun run --filter @ephor/worker exec:wrangler deploy --config /path/to/private-wrangler.jsonc
```

The root `wrangler.jsonc` remains a source-development template, not a required
host configuration. The release installer does not compile it on the host.
Local development uses `bun run dev:worker`; use the local D1 migrations and
localhost origin. Never share production D1 bindings with preview deployments.
