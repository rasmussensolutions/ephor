import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthError, AuthStore } from "../auth/store";
import { Builds } from "./builds";
import { dnsRecords, readDomains } from "./domains";
import { GitHubApp } from "./github-app";
import { checkHttps } from "./https-check";
import { object } from "./spec";
import { Services } from "./store";

export function integrationPublicRoutes(app: Hono, env: AuthEnvironment) {
  const github = new GitHubApp(env.sql, env.secret, env.origin),
    builds = new Builds(env.sql, env.secret, github);
  app.post("/api/integrations/github/webhook", async (c) => {
    const raw = await c.req.text();
    await github.verifyWebhook(raw, c.req.header("x-hub-signature-256") ?? "");
    const delivery = c.req.header("x-github-delivery") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(delivery))
      throw new AuthError("INVALID_WEBHOOK");
    await builds.webhook(
      c.req.header("x-github-event") ?? "",
      JSON.parse(raw),
      delivery,
    );
    return c.json({ ok: true });
  });
}
export function integrationOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const github = new GitHubApp(env.sql, env.secret, env.origin),
    builds = new Builds(env.sql, env.secret, github),
    store = new AuthStore(env.sql);
  app.use("/api/integrations/*", async (c, next) => {
    if (c.req.method !== "GET")
      await requireOwner(
        createAuth(env, c.req.raw.headers),
        store,
        c.req.raw.headers,
        true,
      );
    await next();
  });
  app.get("/api/integrations/github", async (c) =>
    c.json(await github.status()),
  );
  app.get(
    "/api/integrations/github/avatar",
    async (c) =>
      (await github.avatar(c.req.query("installation") ?? "")) ?? c.notFound(),
  );
  app.post("/api/integrations/github/start", async (c) =>
    c.json(await github.start()),
  );
  app.post("/api/integrations/github/finish", async (c) =>
    c.json(await github.finish(await c.req.json())),
  );
  app.post("/api/integrations/github/disconnect", async (c) => {
    await github.disconnect();
    return c.json({ ok: true });
  });
  const page = (v: string | undefined) => {
    const p = Number(v ?? 1);
    if (!Number.isInteger(p) || p < 1 || p > 100)
      throw new AuthError("INVALID_PAGE");
    return p;
  };
  app.get("/api/integrations/github/repositories", async (c) =>
    c.json(
      await github.repositories(
        c.req.query("installation") ?? "",
        page(c.req.query("page")),
      ),
    ),
  );
  app.get("/api/integrations/github/branches", async (c) =>
    c.json(
      await github.branches(
        c.req.query("installation") ?? "",
        c.req.query("repository") ?? "",
        page(c.req.query("page")),
      ),
    ),
  );
  app.post("/api/integrations/build-registry", async (c) => {
    await builds.registry(await c.req.json());
    return c.json({ ok: true });
  });
  app.get("/api/integrations/build-registry", async (c) => {
    const r = await github.integrations.get<{ prefix: string }>(
      "build-registry",
    );
    return c.json({ prefix: r?.prefix ?? null });
  });
  app.get("/api/services/:id/dns", async (c) => {
    const row = await new Services(env.sql, env.secret).get(c.req.param("id"));
    const domains = readDomains(row);
    const [machine] = await env.sql.query<{ telemetry: string | null }>(
      "SELECT telemetry FROM ephor_machine WHERE id=$1",
      [row.machine_id],
    );
    const addresses = JSON.parse(machine?.telemetry ?? "{}").ipAddresses ?? [];
    const results = await Promise.all(
      [domains.primary, ...domains.aliases]
        .filter((s): s is string => !!s)
        .map(async (hostname) => {
          const records = await dnsRecords(hostname);
          return {
            hostname,
            records,
            https: await checkHttps(hostname, records),
            matches:
              records.length > 0 &&
              records.every((r) => addresses.includes(r.value)),
          };
        }),
    );
    return c.json({ addresses, domains: results });
  });
  app.post("/api/services/builds/cancel", async (c) => {
    await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
      true,
    );
    await builds.cancel(object(await c.req.json()).id);
    return c.json({ ok: true });
  });
}
