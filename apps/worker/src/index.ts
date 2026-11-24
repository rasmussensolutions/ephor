import {
  createApi,
  machineReleaseConfig,
  processNotifications,
  processPanelRelease,
  pruneMachineMetrics,
  type Sql,
} from "@ephor/api";

function database(env: Env): Sql {
  return {
    async query<T extends Record<string, unknown>>(
      query: string,
      values: unknown[] = [],
    ) {
      const ordered: unknown[] = [];
      const statement = query.replace(/\$(\d+)/g, (_, index: string) => {
        ordered.push(values[Number(index) - 1]);
        return "?";
      });
      return (
        await env.DB.prepare(statement)
          .bind(...ordered)
          .all<T>()
      ).results;
    },
  } satisfies Sql;
}

export default {
  async scheduled(_controller, env) {
    await processPanelRelease({
      sql: database(env),
      database: env.DB,
      origin: env.EPHOR_ORIGIN,
      ...machineReleaseConfig(
        env.EPHOR_RELEASE_URL,
        env.EPHOR_RELEASE_PUBLIC_KEY,
        true,
      ),
      secret: env.BETTER_AUTH_SECRET,
      deployment: {
        runtime: "cloudflare-worker",
        frontend: "same-runtime",
        panelRoutes: env.EPHOR_PANEL_ROUTES,
      },
    });
    await processNotifications({
      sql: database(env),
      origin: env.EPHOR_ORIGIN,
      secret: env.BETTER_AUTH_SECRET,
    });
    await pruneMachineMetrics(database(env));
    await env.DB.prepare(
      "DELETE FROM ephor_service_metric WHERE observed_at < ?",
    )
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      !url.pathname.startsWith("/api/") &&
      url.pathname !== "/health" &&
      url.pathname !== "/mcp" &&
      !url.pathname.startsWith("/oauth/") &&
      !url.pathname.startsWith("/.well-known/")
    )
      return env.ASSETS.fetch(request);
    const sql = database(env);
    // Never retain D1 bindings or request state in global scope.
    return createApi(
      {
        origin: env.EPHOR_ORIGIN,
        deployment: {
          runtime: "cloudflare-worker",
          frontend: "same-runtime",
          panelRoutes: env.EPHOR_PANEL_ROUTES,
        },
        secret: env.BETTER_AUTH_SECRET,
        setupCode: env.EPHOR_SETUP_CODE || undefined,
        database: env.DB,
        sql,
        ...machineReleaseConfig(
          env.EPHOR_RELEASE_URL,
          env.EPHOR_RELEASE_PUBLIC_KEY,
          true,
        ),
        loadDaemonRelease: async () => {
          const response = await env.ASSETS.fetch(
            new Request(`${env.EPHOR_ORIGIN}/daemon/manifest.json`),
          );
          if (!response.ok) throw new Error("Daemon release is unavailable");
          return response.json();
        },
      },
      (req) => req.headers.get("cf-connecting-ip") ?? "shared",
    ).fetch(request);
  },
} satisfies ExportedHandler<Env>;
