import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthError, AuthStore, hash } from "../auth/store";
import { Backups } from "../backups/store";
import { releaseManifest } from "../machines/installer";
import { Builds } from "./builds";
import { catalog, catalogConfig, template } from "./catalog";
import { ServiceComponents } from "./components";
import { githubIdentity, workflow } from "./github";
import { GitHubApp } from "./github-app";
import { serviceCommand, serviceInstaller } from "./installer";
import { metricsHistory } from "./metrics";
import { updatePresentation } from "./presentation";
import { object } from "./spec";
import { Services } from "./store";
import { ServiceVariables } from "./variables";

function bearer(value: string | undefined) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(value ?? "")?.[1];
  if (!token) throw new AuthError("INVALID_WORKER_CREDENTIAL", 401);
  return token;
}
export function servicePublicRoutes(
  app: Hono,
  env: AuthEnvironment,
  clientIP: (r: Request) => string,
) {
  const services = new Services(env.sql, env.secret),
    store = new AuthStore(env.sql);
  const github = new GitHubApp(env.sql, env.secret, env.origin),
    builds = new Builds(env.sql, env.secret, github);
  app.get("/api/agent/services/install.sh", async (c) => {
    c.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return c.body(
      serviceInstaller(
        env.origin,
        releaseManifest(await env.loadDaemonRelease?.()),
      ),
    );
  });
  app.post("/api/agent/services/enroll", async (c) => {
    await store.limit("service-worker-enrollment", 30);
    const b = object(await c.req.json());
    return c.json(
      await services.enroll(
        bearer(c.req.header("authorization")),
        b.credential,
      ),
    );
  });
  for (const action of [
    "next",
    "report",
    "runtime",
    "heartbeat",
    "backup-next",
    "backup-report",
    "build-next",
    "build-progress",
    "build-report",
  ] as const)
    app.post(`/api/agent/services/${action}`, async (c) => {
      let id: string;
      try {
        id = await services.identity(bearer(c.req.header("authorization")));
      } catch (error) {
        await store.limit(
          `worker-invalid:${await hash(env.secret + clientIP(c.req.raw))}`,
          30,
        );
        throw error;
      }
      await store.limit(`service-worker:${id}`, 180);
      const body = object(await c.req.json());
      if (action === "backup-next")
        return c.json({
          job: await new Backups(env.sql, env.secret).next(id, body.protocol),
        });
      if (action === "backup-report") {
        await new Backups(env.sql, env.secret).report(id, body);
        return c.json({ ok: true });
      }
      if (action === "build-next") {
        if (
          body.protocol !== 2 &&
          body.protocol !== 3 &&
          body.protocol !== 4 &&
          body.protocol !== 5
        )
          throw new AuthError("BUILD_WORKER_REQUIRED", 409);
        await services.heartbeat(id, Number(body.protocol));
        return c.json({ job: await builds.next(id) });
      }
      if (action === "build-progress")
        return c.json(await builds.progress(id, body));
      if (action === "build-report")
        return c.json(await builds.report(id, body));
      if (action === "next")
        return c.json({ job: await services.next(id, body.protocol) });
      if (action === "report") await services.report(id, body);
      else if (action === "runtime") await services.runtime(id, body);
      else
        await services.heartbeat(
          id,
          body.protocol === 5
            ? 5
            : body.protocol === 4
              ? 4
              : body.protocol === 3
                ? 3
                : body.protocol === 2
                  ? 2
                  : 1,
        );
      return c.json({ ok: true });
    });
  app.post("/api/deploy/github/:id/status", async (c) => {
    const row = await services.get(c.req.param("id"));
    await store.limit(`github-deploy:${row.id}`, 10);
    const identity = await githubIdentity(
      c.req.header("authorization")?.replace(/^Bearer /, "") ?? "",
      row.id,
      JSON.parse(row.source),
    );
    const [job] = await env.sql.query(
      "SELECT id,status,error FROM ephor_deployment WHERE service_id=$1 AND delivery=$2",
      [row.id, identity.delivery],
    );
    if (!job) throw new AuthError("DEPLOYMENT_NOT_FOUND", 404);
    return c.json(job);
  });
  app.post("/api/deploy/github/:id", async (c) => {
    const row = await services.get(c.req.param("id"));
    await store.limit(`github-deploy:${row.id}`, 10);
    const source = JSON.parse(row.source);
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const identity = await githubIdentity(token, row.id, source);
    const body = object(await c.req.json());
    if (
      typeof body.image !== "string" ||
      !body.image.startsWith(
        `ghcr.io/${source.repository.toLowerCase()}/ephor-${row.id}@sha256:`,
      )
    )
      throw new AuthError("INVALID_IMAGE");
    return c.json(
      await services.queue(row.id, "deploy", {
        ...identity,
        image: body.image,
      }),
    );
  });
}
export function serviceOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const services = new Services(env.sql, env.secret),
    store = new AuthStore(env.sql);
  const variables = new ServiceVariables(env.sql, env.secret);
  const components = new ServiceComponents(env.sql, env.secret);
  app.get("/api/services/:id/components/:component/metrics", async (c) =>
    c.json(
      await components.metrics(
        c.req.param("id"),
        c.req.param("component"),
        c.req.query("range") ?? "1h",
      ),
    ),
  );
  app.get("/api/services/:id/components/:component/variables", async (c) =>
    c.json(
      await components.variables(c.req.param("id"), c.req.param("component")),
    ),
  );
  const github = new GitHubApp(env.sql, env.secret, env.origin),
    builds = new Builds(env.sql, env.secret, github);
  app.get("/api/services", async (c) =>
    c.json({
      services: await services.list(undefined, c.req.query("summary") === "1"),
      deployments: await services.history(),
      workers: await services.workers(),
      builds: await builds.list(undefined, c.req.query("summary") === "1"),
    }),
  );
  app.get("/api/services/catalog", (c) => c.json({ apps: catalog() }));
  app.get("/api/services/:id", async (c) => {
    const row = await services.get(c.req.param("id"));
    const [items, deployments, workers, history] = await Promise.all([
      services.list(row.id),
      services.history(row.id),
      services.workers(),
      builds.list(row.id),
    ]);
    return c.json({
      services: items,
      deployments,
      workers: workers.filter((w) => w.machine_id === row.machine_id),
      builds: history,
    });
  });
  app.get("/api/services/:id/metrics", async (c) => {
    const row = await services.get(c.req.param("id"));
    return c.json(
      await metricsHistory(env.sql, row.id, c.req.query("range") ?? "1h"),
    );
  });
  app.get("/api/services/:id/variables", async (c) =>
    c.json(await variables.list(c.req.param("id"))),
  );
  app.get("/api/services/:id/workflow", async (c) => {
    const row = await services.get(c.req.param("id")),
      source = JSON.parse(row.source);
    if (source.type !== "github")
      throw new AuthError("NOT_A_REPOSITORY_SERVICE");
    return c.json({
      filename: `.github/workflows/ephor-${row.id}.yml`,
      content: workflow(row.id, source, env.origin),
    });
  });
  // Owner authentication and same-origin checks already apply. Cosmetic edits
  // do not require the fresh passkey used for infrastructure mutations below.
  app.post("/api/services/:id/presentation", async (c) =>
    c.json(
      await updatePresentation(
        env.sql,
        env.secret,
        c.req.param("id"),
        await c.req.json(),
      ),
    ),
  );
  app.use("/api/services/*", async (c, next) => {
    if (c.req.method !== "GET")
      await requireOwner(
        createAuth(env, c.req.raw.headers),
        store,
        c.req.raw.headers,
        true,
      );
    await next();
  });
  app.post("/api/services/catalog/deploy", async (c) => {
    const b = object(await c.req.json()),
      t = template(b.template);
    if (t.web && !b.domain) throw new AuthError("CATALOG_DOMAIN_REQUIRED");
    if (!t.web && b.domain) throw new AuthError("DATABASE_MUST_BE_PRIVATE");
    const { config, source } = catalogConfig(t.id);
    const created = await services.create(
      {
        machineId: b.machineId,
        name: b.name ?? t.name,
        domain: b.domain,
        spec: config,
      },
      source,
    );
    let deploymentError: string | null = null;
    try {
      await services.queue(created.id, "deploy");
    } catch (error) {
      if (error instanceof AuthError) deploymentError = error.code;
      else throw error;
    }
    return c.json({ ...created, deploymentError });
  });
  app.post(
    "/api/services/:id/components/:component/variables/reveal",
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(
        await components.reveal(
          c.req.param("id"),
          c.req.param("component"),
          await c.req.json(),
        ),
      );
    },
  );
  app.post("/api/services/:id/variables/reveal", async (c) =>
    c.json(await variables.reveal(c.req.param("id"), await c.req.json())),
  );
  app.post("/api/services/:id/variables", async (c) =>
    c.json(await variables.update(c.req.param("id"), await c.req.json())),
  );
  app.post("/api/services/:id/catalog-access", async (c) => {
    const b = object(await c.req.json());
    c.header("Cache-Control", "no-store");
    return c.json(
      await services.catalogAccess(
        c.req.param("id"),
        b.publish === true ? false : b.protect === true ? true : undefined,
      ),
    );
  });
  app.post("/api/services/create", async (c) => {
    const body = object(await c.req.json());
    if (body.buildEnvironment !== undefined)
      builds.validateEnvironment(body.buildEnvironment);
    const source = await github.source(body.source);
    const created = await services.create(body, source);
    if (body.buildEnvironment !== undefined)
      await builds.setEnvironment(created.id, body.buildEnvironment);
    let deploymentError: string | null = null;
    if (body.deploy === true) {
      try {
        if (source.installationId) await builds.queue(created.id);
        else await services.queue(created.id, "deploy");
      } catch (error) {
        if (error instanceof AuthError) deploymentError = error.code;
        else throw error;
      }
    }
    return c.json({ ...created, deploymentError });
  });
  app.post("/api/services/worker", async (c) => {
    const body = object(await c.req.json());
    const manifest = releaseManifest(await env.loadDaemonRelease?.());
    if (!manifest.serviceProtocol || manifest.serviceProtocol < 2)
      throw new AuthError("SERVICE_BUILD_REQUIRED", 409);
    const token = await services.issueWorker(body.machineId);
    await store.audit(
      "service.worker_enrollment_issued",
      String(body.machineId),
    );
    return c.json({
      command: serviceCommand(env.origin, token),
      expiresAt: Date.now() + 600000,
    });
  });
  app.post("/api/services/:id/configure", async (c) => {
    const body = object(await c.req.json());
    if (body.buildEnvironment !== undefined)
      builds.validateEnvironment(body.buildEnvironment);
    await services.configure(
      c.req.param("id"),
      body,
      body.source ? await github.source(body.source) : undefined,
    );
    if (body.buildEnvironment !== undefined)
      await builds.setEnvironment(c.req.param("id"), body.buildEnvironment);
    return c.json({ ok: true });
  });
  app.post("/api/services/:id/action", async (c) => {
    const body = object(await c.req.json());
    const row = await services.get(c.req.param("id"));
    if (body.action === "deploy" && JSON.parse(row.source).installationId)
      return c.json(await builds.queue(row.id));
    if (body.action === "stop" || body.action === "rollback")
      await env.sql.query(
        "UPDATE ephor_build SET status='cancelled',updated_at=$1 WHERE service_id=$2 AND status IN ('queued','running','built')",
        [Date.now(), row.id],
      );
    return c.json(
      await services.queue(c.req.param("id"), String(body.action), {
        deploymentId: body.deploymentId,
        backupId: body.backupId,
      }),
    );
  });
  app.post("/api/services/cancel", async (c) => {
    const b = object(await c.req.json());
    await services.cancel(b.id);
    return c.json({ ok: true });
  });
}
