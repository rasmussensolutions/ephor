import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { catalogConfig, template } from "../src/services/catalog";
import {
  METRIC_RETENTION,
  metricsHistory,
  recordMetrics,
} from "../src/services/metrics";
import { Services } from "../src/services/store";
import { topology } from "../src/services/topology";
import { enrolled, timestamp } from "./helpers";

const metrics = {
  cpuPercent: 4,
  memoryBytes: 1000,
  memoryLimitBytes: 2000,
  networkRxBytesPerSecond: 12,
  networkTxBytesPerSecond: 24,
  uptimeSeconds: 60,
  processes: 2,
  restarts: 0,
};
async function setup() {
  const f = await enrolled(),
    services = new Services(f.sql, f.env.secret),
    machines = new MachineStore(f.sql);
  const machine = await machines.create("components");
  await machines.enroll(machine.token, randomToken());
  const { config, source } = catalogConfig("umami");
  const { id } = await services.create(
    {
      machineId: machine.id,
      name: "Analytics",
      domain: "analytics.example.org",
      spec: config,
    },
    source,
  );
  const report = {
    id,
    status: "running",
    container: "app-web",
    logs: "app logs",
    metrics: { ...metrics, memoryBytes: 3000 },
    catalog: {
      components: template("umami", 1).components.map((c) => ({
        name: c.id,
        image: c.image,
        status: "running",
        logs: `${c.id}: ${config.environment.DB_PASSWORD}\u001b`,
        metrics: { ...metrics, memoryBytes: c.id === "web" ? 1000 : 2000 },
      })),
      volumes: [],
      backups: [],
      port: 3000,
      recoveryRequired: false,
    },
  };
  return { ...f, services, machine, config, id, report };
}
test("component reports retain independent telemetry and redact secrets; map summaries omit all logs", async () => {
  const f = await setup();
  await f.services.runtime(f.machine.id, f.report);
  const detail = (await f.services.list(f.id))[0];
  expect(detail?.topology?.dependencies).toEqual([
    { from: "web", to: "database", variables: ["DATABASE_URL"] },
  ]);
  expect(
    detail?.runtime?.catalog?.components.map((c) => c.metrics?.memoryBytes),
  ).toEqual([2000, 1000]);
  expect(detail?.runtime?.catalog?.components[0]?.logs).toBe(
    "database: [redacted]",
  );
  expect(JSON.stringify(detail)).not.toContain(
    f.config.environment.DB_PASSWORD as string,
  );
  const summary = (await f.services.list(f.id, true))[0];
  expect(summary?.runtime?.logs).toBe("");
  expect(
    summary?.runtime?.catalog?.components.every((c) => c.logs === undefined),
  ).toBe(true);
  const history = await (
    await f.browser.request(
      `/services/${f.id}/components/database/metrics?range=1h`,
    )
  ).json();
  expect(
    history.points
      .filter((p: { memoryBytes: number | null }) => p.memoryBytes !== null)
      .map((p: { memoryBytes: number }) => p.memoryBytes),
  ).toEqual([2000]);
  const web = await metricsHistory(f.sql, f.id, "1h", Date.now(), "web");
  expect(
    web.points.filter((p) => p.memoryBytes !== null).map((p) => p.memoryBytes),
  ).toEqual([1000]);
  expect(
    (await metricsHistory(f.sql, f.id, "1h")).points.some(
      (p) => p.memoryBytes === 3000,
    ),
  ).toBe(true);
  // Legacy workers still work, and never fabricate zero usage or mix app logs into child logs.
  await f.services.runtime(f.machine.id, {
    ...f.report,
    catalog: {
      ...f.report.catalog,
      components: f.report.catalog.components.map(
        ({ name, image, status }) => ({ name, image, status }),
      ),
    },
  });
  const legacy = (await f.services.list(f.id))[0]?.runtime?.catalog
    ?.components[0];
  expect(legacy?.metrics).toBeUndefined();
  expect(legacy?.logs).toBeUndefined();
});
test("component reports reject forged identities, duplicate components, malformed metrics and foreign workers", async () => {
  const f = await setup(),
    component = f.report.catalog.components[0];
  if (!component) throw new Error("Missing fixture component");
  for (const components of [
    [{ ...component, name: "unknown" }],
    [component, component],
    [{ ...component, image: "wrong-image" }],
    [{ ...component, metrics: { ...metrics, memoryBytes: -1 } }],
    [{ ...component, logs: "x".repeat(6001) }],
  ]) {
    await expect(
      f.services.runtime(f.machine.id, {
        ...f.report,
        catalog: { ...f.report.catalog, components },
      }),
    ).rejects.toThrow();
  }
  await expect(
    f.services.runtime(crypto.randomUUID(), f.report),
  ).rejects.toThrow("SERVICE_NOT_FOUND");
  expect((await f.services.get(f.id)).runtime).toBeNull();
  expect(
    (await f.browser.request(`/services/${f.id}/components/unknown/metrics`))
      .status,
  ).toBe(404);
  expect(
    (await f.app.request(`/api/services/${f.id}/components/web/metrics`))
      .status,
  ).toBe(401);
});
test("effective component variables use app secret references, fresh owner authentication and revision checks", async () => {
  const f = await setup(),
    endpoint = `/services/${f.id}/components/web/variables`;
  const meta = await (await f.browser.request(endpoint)).json();
  expect(meta.variables).toContainEqual({
    name: "DATABASE_URL",
    references: ["DB_PASSWORD"],
  });
  expect(JSON.stringify(meta)).not.toContain(
    f.config.environment.DB_PASSWORD as string,
  );
  const response = await f.browser.request(`${endpoint}/reveal`, {
    revision: meta.revision,
    name: "DATABASE_URL",
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await response.json()).value).toBe(
    `postgresql://ephor:${f.config.environment.DB_PASSWORD}@database:5432/app`,
  );
  const dbMeta = await (
    await f.browser.request(`/services/${f.id}/components/database/variables`)
  ).json();
  expect(dbMeta.variables).toContainEqual({
    name: "POSTGRES_PASSWORD",
    references: ["DB_PASSWORD"],
  });
  expect(
    (
      await f.browser.request(`${endpoint}/reveal`, {
        revision: "stale",
        name: "DATABASE_URL",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.browser.request(`${endpoint}/reveal`, {
        revision: meta.revision,
        name: "POSTGRES_PASSWORD",
      })
    ).status,
  ).toBe(404);
  expect(
    (await f.browser.request(endpoint, { set: { DATABASE_URL: "override" } }))
      .status,
  ).toBe(404);
  expect((await f.app.request(`/api${endpoint}`)).status).toBe(401);
  expect(
    (
      await f.browser.request(
        `${endpoint}/reveal`,
        { revision: meta.revision, name: "DATABASE_URL" },
        { origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect(
    (
      await f.browser.request(`${endpoint}/reveal`, {
        revision: meta.revision,
        name: "DATABASE_URL",
      })
    ).status,
  ).toBe(403);
  expect((await f.browser.request(endpoint)).status).toBe(200);
});
test("component history is isolated by app and name, expires after 24 hours and cascades on deletion", async () => {
  const f = await setup(),
    now = Date.now();
  await recordMetrics(f.sql, f.id, metrics, now - METRIC_RETENTION - 1, "web");
  await recordMetrics(f.sql, f.id, metrics, now, "database");
  expect(
    (await metricsHistory(f.sql, f.id, "24h", now, "web")).points.every(
      (p) => p.memoryBytes === null,
    ),
  ).toBe(true);
  expect(
    (
      await metricsHistory(f.sql, crypto.randomUUID(), "1h", now, "database")
    ).points.every((p) => p.memoryBytes === null),
  ).toBe(true);
  await f.sql.query("DELETE FROM ephor_service_domain WHERE service_id=$1", [
    f.id,
  ]);
  await f.sql.query("DELETE FROM ephor_service WHERE id=$1", [f.id]);
  expect(
    await f.sql.query(
      "SELECT * FROM ephor_component_metric WHERE service_id=$1",
      [f.id],
    ),
  ).toEqual([]);
});
test("topology edges only reference components and environment entries in the pinned recipe", () => {
  for (const id of ["umami", "wordpress", "postgres", "redis", "uptime-kuma"]) {
    const config = catalogConfig(id).config.catalog;
    if (!config) throw new Error("No catalog configuration");
    const graph = topology(config),
      recipe = template(id, config.version);
    const primary = recipe.components.at(-1);
    if (!primary) throw new Error("Catalog recipe has no components");
    expect(graph.primary).toBe(primary.id);
    expect(graph.web).toBe(recipe.web);
    for (const edge of graph.dependencies) {
      expect(graph.components.some((c) => c.name === edge.to)).toBe(true);
      const from = recipe.components.find((c) => c.id === edge.from);
      expect(from).toBeDefined();
      for (const variable of edge.variables)
        expect(Object.hasOwn(from?.environment ?? {}, variable)).toBe(true);
    }
  }
});

test("display settings persist independently and never modify runtime configuration", async () => {
  const f = await setup(),
    before = await f.services.get(f.id);
  const endpoint = `/services/${f.id}/presentation`;
  const group = await f.browser.request(endpoint, {
    groupName: "Analytics stack",
    groupColor: "violet",
  });
  expect(group.status).toBe(200);
  expect((await group.json()).presentation).toEqual({
    groupName: "Analytics stack",
    groupColor: "violet",
    componentNames: {},
  });
  expect(
    (await f.browser.request(endpoint, { name: "Traffic insights" })).status,
  ).toBe(200);
  expect(
    (
      await f.browser.request(endpoint, {
        component: { id: "database", name: "Analytics database" },
      })
    ).status,
  ).toBe(200);
  const saved = (await f.services.list(f.id))[0];
  expect(saved?.name).toBe("Traffic insights");
  expect(saved?.presentation).toEqual({
    groupName: "Analytics stack",
    groupColor: "violet",
    componentNames: { database: "Analytics database" },
  });
  const after = await f.services.get(f.id);
  expect(after.config).toBe(before.config);
  expect(after.domain).toBe(before.domain);
  expect(after.source).toBe(before.source);
  expect(await f.services.history(f.id)).toEqual([]);
  // Group name stays independent even before its first customization.
  const cfg = catalogConfig("umami"),
    other = await f.services.create(
      {
        machineId: f.machine.id,
        name: "Original",
        domain: "other.example.org",
        spec: cfg.config,
      },
      cfg.source,
    );
  await f.browser.request(`/services/${other.id}/presentation`, {
    name: "New primary",
  });
  expect((await f.services.list(other.id))[0]?.presentation.groupName).toBe(
    "Original",
  );
});
test("presentation edits enforce owner, origin, bounds and real component/group membership", async () => {
  const f = await setup(),
    endpoint = `/services/${f.id}/presentation`;
  for (const patch of [
    { name: " " },
    { name: "a".repeat(81) },
    { name: "bad\nname" },
    { groupColor: "url(evil)" },
    { config: {} },
    { component: { id: "web", name: "Wrong route" } },
  ]) {
    expect((await f.browser.request(endpoint, patch)).status).toBe(400);
  }
  expect(
    (
      await f.browser.request(endpoint, {
        component: { id: "unknown", name: "Invalid" },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.app.request(`/api${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: f.env.origin },
        body: JSON.stringify({ name: "Unauthorized" }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.browser.request(
        endpoint,
        { name: "Bad origin" },
        { origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect(
    (await f.browser.request(endpoint, { name: "Cosmetic edit" })).status,
  ).toBe(200);
  const cfg = catalogConfig("postgres"),
    single = await f.services.create(
      { machineId: f.machine.id, name: "Postgres", spec: cfg.config },
      cfg.source,
    );
  expect(
    (
      await f.browser.request(`/services/${single.id}/presentation`, {
        groupName: "Not a group",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.browser.request(`/services/${single.id}/presentation`, {
        name: "Data warehouse",
      })
    ).status,
  ).toBe(200);
});

test("map positions persist across reads and independently per card without touching deployments", async () => {
  const f = await setup(),
    before = await f.services.get(f.id);
  const endpoint = `/services/${f.id}/presentation`;
  for (const position of [
    { x: 81, y: 402 },
    { component: "web", x: 120, y: 8 },
    { component: "database", x: 16, y: 320 },
  ]) {
    expect((await f.browser.request(endpoint, { position })).status).toBe(200);
  }
  // A fresh store represents another browser's subsequent service-list read.
  const fresh = new Services(f.sql, f.env.secret);
  expect((await fresh.list(f.id, true))[0]?.presentation.positions).toEqual({
    "": { x: 81, y: 402, revision: 1 },
    web: { x: 120, y: 8, revision: 1 },
    database: { x: 16, y: 320, revision: 1 },
  });
  await f.browser.request(endpoint, {
    position: { component: "web", x: 200, y: 40 },
  });
  await f.browser.request(endpoint, { name: "Renamed primary" });
  const saved = (await fresh.list(f.id))[0];
  expect(saved?.presentation.positions?.database).toEqual({
    x: 16,
    y: 320,
    revision: 1,
  });
  expect(saved?.presentation.positions?.web).toEqual({
    x: 200,
    y: 40,
    revision: 2,
  });
  expect((await f.services.get(f.id)).config).toBe(before.config);
  expect(await f.services.history(f.id)).toEqual([]);
  await f.sql.query("DELETE FROM ephor_service_domain WHERE service_id=$1", [
    f.id,
  ]);
  await f.sql.query("DELETE FROM ephor_service WHERE id=$1", [f.id]);
  expect(
    await f.sql.query(
      "SELECT * FROM ephor_service_map_position WHERE service_id=$1",
      [f.id],
    ),
  ).toEqual([]);
});

test("map positions validate bounds, ownership, origin and component membership", async () => {
  const f = await setup(),
    endpoint = `/services/${f.id}/presentation`;
  for (const position of [
    { x: -1, y: 0 },
    { x: 20001, y: 0 },
    { x: "8", y: 0 },
    { x: null, y: 0 },
    { x: 0 },
    { x: 0, y: 0, extra: true },
  ]) {
    expect((await f.browser.request(endpoint, { position })).status).toBe(400);
  }
  expect(
    (
      await f.browser.request(endpoint, {
        position: { component: "unknown", x: 0, y: 0 },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.browser.request(endpoint, {
        position: { x: 0, y: 0 },
        name: "Mixed mutation",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.browser.request(
        endpoint,
        { position: { x: 0, y: 0 } },
        { origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(`/api${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: f.env.origin },
        body: JSON.stringify({ position: { x: 0, y: 0 } }),
      })
    ).status,
  ).toBe(401);
  const cfg = catalogConfig("postgres"),
    single = await f.services.create(
      { machineId: f.machine.id, name: "Single", spec: cfg.config },
      cfg.source,
    );
  expect(
    (
      await f.browser.request(`/services/${single.id}/presentation`, {
        position: { component: "database", x: 0, y: 0 },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.browser.request(`/services/${single.id}/presentation`, {
        position: { x: 0, y: 20000 },
      })
    ).status,
  ).toBe(200);
});
