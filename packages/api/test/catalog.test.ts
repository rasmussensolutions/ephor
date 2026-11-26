import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { catalog, catalogConfig, template } from "../src/services/catalog";
import { Services } from "../src/services/store";
import { enrolled, timestamp } from "./helpers";

test("new PostgreSQL services use pgvector 18 without changing existing version 1 recipes", () => {
  const current = catalogConfig("postgres");
  expect(current.config.catalog?.version).toBe(2);
  expect(current.config.image).toContain("pgvector/pgvector@sha256:");
  const legacy = template("postgres", 1).components[0];
  expect(legacy?.image).toContain("library/postgres@sha256:");
  expect(legacy?.volumes[0]?.target).toBe("/var/lib/postgresql/data");
  const modern = template("postgres", 2).components[0];
  expect(
    (modern?.environment as Record<string, string> | undefined)?.PGDATA,
  ).toBe("/var/lib/postgresql/18/docker");
  expect(modern?.volumes[0]?.target).toBe("/var/lib/postgresql");
  expect(modern?.user).toBe("999:999");
});

async function setup() {
  const f = await enrolled(),
    services = new Services(f.sql, f.env.secret),
    machines = new MachineStore(f.sql);
  const m = await machines.create("catalog-vps");
  await machines.enroll(m.token, randomToken());
  await services.enroll(await services.issueWorker(m.id), randomToken());
  await services.heartbeat(m.id, 3);
  return { ...f, services, machineId: m.id };
}
test("catalog deploy generates encrypted unique secrets, pins templates, and isolates protocol 3 jobs", async () => {
  const f = await setup();
  const response = await f.browser.request("/services/catalog/deploy", {
    machineId: f.machineId,
    template: "wordpress",
    name: "Blog",
    domain: "blog.acme.org",
    spec: { privileged: true },
    environment: { DB_PASSWORD: "override" },
  });
  expect(response.status).toBe(200);
  const { id, deploymentError } = await response.json();
  expect(deploymentError).toBeNull();
  expect(await f.services.next(f.machineId, 2)).toBeNull();
  const job = await f.services.next(f.machineId, 3);
  expect(job?.serviceId).toBe(id);
  expect(job?.spec.catalog?.protected).toBe(true);
  expect(job?.spec.environment.DB_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
  expect(job?.spec.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  const raw = JSON.stringify(
    await f.sql.query("SELECT config FROM ephor_service"),
  );
  expect(raw).not.toContain(job?.spec.environment.DB_PASSWORD ?? "secret");
  const listed = JSON.stringify(
    await (await f.browser.request(`/services/${id}`)).json(),
  );
  expect(listed).not.toContain(job?.spec.environment.DB_PASSWORD ?? "secret");
  expect(
    (await f.browser.request(`/services/${id}/catalog-access`, {})).headers.get(
      "Cache-Control",
    ),
  ).toBe("no-store");
  expect(
    (
      await (
        await f.browser.request(`/services/${id}/catalog-access`, {})
      ).json()
    ).credentials.DB_PASSWORD,
  ).toBe(job?.spec.environment.DB_PASSWORD);
  await f.services.report(f.machineId, {
    id: job?.id,
    status: "succeeded",
    digest: job?.spec.image,
  });
  await expect(
    f.services.queue(id, "rollback", { deploymentId: job?.id }),
  ).rejects.toThrow("CATALOG_ROLLBACK_BLOCKED");
  await expect(
    f.services.configure(id, { spec: catalogConfig("redis").config }),
  ).rejects.toThrow("CATALOG_CONFIG_LOCKED");
  await f.services.heartbeat(f.machineId, 2);
  await expect(f.services.queue(id, "backup")).rejects.toThrow(
    "CATALOG_WORKER_REQUIRED",
  );
  await f.services.heartbeat(f.machineId, 3);
  const backup = await f.services.queue(id, "backup");
  expect(await f.services.next(f.machineId, 2)).toBeNull();
  await f.services.next(f.machineId, 3);
  await f.services.report(f.machineId, { id: backup.id, status: "succeeded" });
  expect((await f.services.get(id)).current_deployment).toBe(job?.id ?? null);
  const b = crypto.randomUUID();
  await f.services.queue(id, "restore", { backupId: b });
  expect((await f.services.next(f.machineId, 3))?.backupId).toBe(b);
});
test("catalog boundaries require owner reauthentication and prohibit public databases and custom recipe overrides", async () => {
  const f = await setup();
  const body = { machineId: f.machineId, template: "postgres", name: "DB" };
  expect((await f.app.request("/api/services/catalog")).status).toBe(401);
  expect((await f.browser.request("/services/catalog")).status).toBe(200);
  expect(
    (
      await f.browser.request("/services/catalog/deploy", {
        ...body,
        domain: "db.acme.org",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.browser.request("/services/catalog/deploy", {
        ...body,
        template: "wordpress",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.browser.request("/services/catalog/deploy", {
        ...body,
        template: "../../evil",
      })
    ).status,
  ).toBe(404);
  const { id } = await (
    await f.browser.request("/services/catalog/deploy", body)
  ).json();
  expect(
    (
      await f.browser.request(
        `/services/${id}/catalog-access`,
        {},
        { origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  const cfg = catalogConfig("postgres");
  await expect(
    f.services.create({ ...body, spec: cfg.config }, { type: "image" }),
  ).rejects.toThrow();
  const first = (await f.services.next(f.machineId, 3))?.spec.environment
    .DB_PASSWORD;
  const other = catalogConfig("postgres").config.environment.DB_PASSWORD;
  expect(first).not.toBe(other);
  expect(
    (
      await f.browser.request(`/services/${id}/action`, {
        action: "restore",
        backupId: "../../",
      })
    ).status,
  ).toBe(400);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect(
    (await f.browser.request(`/services/${id}/catalog-access`, {})).status,
  ).toBe(403);
  expect(
    (await f.browser.request("/services/catalog/deploy", body)).status,
  ).toBe(403);
});
test("every catalog recipe has bounded resources, immutable upstream images, and unique storage keys", () => {
  for (const app of catalog()) {
    expect(app.components.length).toBeGreaterThan(0);
    expect(app.memoryMb).toBeGreaterThanOrEqual(64);
    for (const c of app.components)
      expect(c.image).toMatch(/^[a-z0-9./-]+@sha256:[a-f0-9]{64}$/);
    const a = catalogConfig(app.id),
      b = catalogConfig(app.id);
    expect(a.config.environment).not.toEqual(b.config.environment);
  }
});

test("PostgreSQL extension settings are additive, validated and require a new worker", async () => {
  const f = await setup();
  const cfg = catalogConfig("postgres");
  const created = await f.services.create(
    { machineId: f.machineId, name: "Extensions", spec: cfg.config },
    cfg.source,
  );
  await expect(f.services.queue(created.id, "deploy")).rejects.toThrow(
    "STATEFUL_WORKER_REQUIRED",
  );
  await expect(
    f.services.extensions(created.id, {
      extensions: ["vector; DROP TABLE users"],
    }),
  ).rejects.toThrow("INVALID_POSTGRES_EXTENSIONS");
  await f.services.extensions(created.id, { extensions: ["vector"] });
  await f.services.extensions(created.id, { extensions: ["pg_trgm"] });
  await f.services.heartbeat(f.machineId, 8);
  await f.services.queue(created.id, "deploy");
  expect(await f.services.next(f.machineId, 7)).toBeNull();
  const job = await f.services.next(f.machineId, 8);
  expect(job?.spec.catalog?.extensions).toEqual(["vector", "pg_trgm"]);
});
