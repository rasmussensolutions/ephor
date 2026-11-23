import { expect, test } from "bun:test";
import { describeActivity } from "../src/activity/middleware";
import type { ActivityList } from "../src/activity/types";
import { randomToken, type Sql } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { catalogConfig } from "../src/services/catalog";
import { updateMapPositions } from "../src/services/presentation";
import { Services } from "../src/services/store";
import { Browser, enrolled, timestamp } from "./helpers";

const endpoint = "/services/map-positions";

async function setup(count = 3) {
  const f = await enrolled();
  const services = new Services(f.sql, f.env.secret);
  const machines = new MachineStore(f.sql);
  const ids: string[] = [];
  let machineId = "";
  for (let index = 0; index < count; index++) {
    if (index % 16 === 0) {
      const machine = await machines.create(`Layout machine ${index / 16}`);
      await machines.enroll(machine.token, randomToken());
      machineId = machine.id;
    }
    const { config, source } =
      index === 0
        ? catalogConfig("umami")
        : {
            config: {
              image: "docker.io/library/nginx:latest",
              port: 3000,
              healthPath: "/",
              memoryMb: 256,
              cpus: 0.5,
              environment: { SECRET: "private-layout-test-value" },
              registry: null,
            },
            source: { type: "image" as const },
          };
    const created = await services.create(
      {
        machineId,
        name: `Layout service ${index}`,
        domain: index === 0 ? "analytics.example.org" : null,
        spec: config,
      },
      source,
    );
    ids.push(created.id);
  }
  const [group, ordinary, untouched] = ids;
  if (!group || !ordinary || !untouched)
    throw new Error("Missing layout fixture services");
  return { ...f, services, ids, group, ordinary, untouched };
}

async function layoutState(sql: Sql) {
  return {
    positions: await sql.query(
      "SELECT * FROM ephor_service_map_position ORDER BY service_id,component_id",
    ),
    audit: await sql.query(
      "SELECT * FROM ephor_auth_audit WHERE event='service.layout_updated' ORDER BY id",
    ),
  };
}

test("batched root positions preserve children, current metadata, configs and unaffected services", async () => {
  const f = await setup();
  for (const patch of [
    { groupName: "Analytics stack", groupColor: "violet" },
    { name: "Traffic insights" },
    { component: { id: "database", name: "Analytics database" } },
    { position: { x: 81, y: 402 } },
    { position: { component: "web", x: 120, y: 8 } },
    { position: { component: "database", x: 16, y: 320 } },
  ]) {
    expect(
      (await f.browser.request(`/services/${f.group}/presentation`, patch))
        .status,
    ).toBe(200);
  }
  await f.browser.request(`/services/${f.untouched}/presentation`, {
    position: { x: 999, y: 888 },
  });
  const ordinary = await f.services.get(f.ordinary);
  await f.services.runtime(ordinary.machine_id, {
    id: f.ordinary,
    status: "running",
    container: "ordinary",
    logs: "private-layout-test-value",
    metrics: null,
  });
  const before = await Promise.all(f.ids.map((id) => f.services.get(id)));
  const positions = [
    { id: f.group, x: 0, y: 20000 },
    { id: f.ordinary, x: 24.5, y: 19999.5 },
  ];
  const response = await f.browser.request(endpoint, { positions });
  expect(response.status).toBe(200);
  const body = await response.json();
  const current = (await f.services.list(undefined, true))
    .filter((service) =>
      positions.some((position) => position.id === service.id),
    )
    .map(({ id, name, presentation }) => ({ id, name, presentation }));
  expect(body).toEqual({ services: expect.arrayContaining(current) });
  expect(body.services).toHaveLength(2);
  const group = current.find((service) => service.id === f.group);
  expect(group?.name).toBe("Traffic insights");
  expect(group?.presentation).toEqual({
    groupName: "Analytics stack",
    groupColor: "violet",
    componentNames: { database: "Analytics database" },
    positions: {
      "": { x: 0, y: 20000, revision: 2 },
      web: { x: 120, y: 8, revision: 1 },
      database: { x: 16, y: 320, revision: 1 },
    },
  });
  const savedOrdinary = current.find((service) => service.id === f.ordinary);
  expect(savedOrdinary?.presentation.positions?.[""]).toEqual({
    x: 24.5,
    y: 19999.5,
    revision: 1,
  });
  for (const service of body.services) {
    expect(Object.keys(service).sort()).toEqual(["id", "name", "presentation"]);
  }
  expect(JSON.stringify(body)).not.toContain("private-layout-test-value");
  expect(
    (await f.services.list(f.untouched, true))[0]?.presentation.positions?.[""],
  ).toEqual({ x: 999, y: 888, revision: 1 });
  expect(await Promise.all(f.ids.map((id) => f.services.get(id)))).toEqual(
    before,
  );
  expect(await f.services.history()).toEqual([]);
  expect(
    await f.sql.query(
      "SELECT event,subject FROM ephor_auth_audit WHERE event='service.layout_updated' AND subject IS NULL",
    ),
  ).toEqual([{ event: "service.layout_updated", subject: null }]);

  expect((await f.browser.request(endpoint, { positions })).status).toBe(200);
  const fresh = new Services(f.sql, f.env.secret);
  expect((await fresh.list(f.group, true))[0]?.presentation.positions).toEqual({
    "": { x: 0, y: 20000, revision: 3 },
    web: { x: 120, y: 8, revision: 1 },
    database: { x: 16, y: 320, revision: 1 },
  });
  expect(
    (await fresh.list(f.ordinary, true))[0]?.presentation.positions?.[""],
  ).toEqual({ x: 24.5, y: 19999.5, revision: 2 });
});

test("batch uses one root upsert and targeted reads, returning metadata changed after ID verification", async () => {
  const f = await setup();
  const queries: { text: string; values: unknown[] }[] = [];
  const sql: Sql = {
    async query<T extends Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      queries.push({ text, values });
      if (text.startsWith("INSERT INTO ephor_service_map_position")) {
        await f.sql.query(
          "UPDATE ephor_service SET name=$1,group_name=$2,group_color=$3,component_names=$4 WHERE id=$5",
          [
            "Concurrent primary name",
            "Concurrent group name",
            "amber",
            JSON.stringify({ database: "Concurrent database name" }),
            f.group,
          ],
        );
      }
      return f.sql.query<T>(text, values);
    },
  };
  const result = await updateMapPositions(sql, {
    positions: [
      { id: f.group, x: 24, y: 48 },
      { id: f.ordinary, x: 96, y: 120 },
    ],
  });
  const writes = queries.filter(({ text }) =>
    text.startsWith("INSERT INTO ephor_service_map_position"),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]?.values).toHaveLength(6);
  expect(writes[0]?.text).toContain("($1,'',$2,$3),($4,'',$5,$6)");
  const reads = queries.filter(({ text }) => text.startsWith("SELECT "));
  expect(reads).toHaveLength(3);
  for (const { text, values } of reads) {
    expect(text).toContain(" IN ($1,$2)");
    expect(text).not.toMatch(/\*|\b(config|runtime|source|LIMIT)\b/);
    expect(values).toEqual([f.group, f.ordinary]);
  }
  expect(result.services.find((service) => service.id === f.group)).toEqual({
    id: f.group,
    name: "Concurrent primary name",
    presentation: {
      groupName: "Concurrent group name",
      groupColor: "amber",
      componentNames: { database: "Concurrent database name" },
      positions: { "": { x: 24, y: 48, revision: 1 } },
    },
  });
});

test("targeted responses include affected old services beyond the global list limit without decrypting any configs", async () => {
  const f = await setup();
  const { machine_id: machineId } = await f.services.get(f.group);
  const createdAt = Date.now() + 10000;
  for (let start = 0; start < 1001; start += 16) {
    const values: unknown[] = [];
    const rows = Array.from(
      { length: Math.min(16, 1001 - start) },
      (_, index) => {
        const offset = values.length;
        values.push(
          crypto.randomUUID(),
          machineId,
          "Unrelated newer service",
          "unreadable-config",
          JSON.stringify({ type: "image" }),
          createdAt + start + index,
        );
        return `(${Array.from({ length: 6 }, (_, column) => `$${offset + column + 1}`).join(",")})`;
      },
    );
    await f.sql.query(
      `INSERT INTO ephor_service (id,machine_id,name,config,source,created_at) VALUES ${rows.join(",")}`,
      values,
    );
  }
  await f.sql.query("UPDATE ephor_service SET config=$1 WHERE id IN ($2,$3)", [
    "unreadable-affected-config",
    f.group,
    f.ordinary,
  ]);
  const positions = [
    { id: f.group, x: 24, y: 48 },
    { id: f.ordinary, x: 96, y: 120 },
  ];
  const response = await f.browser.request(endpoint, { positions });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.services).toHaveLength(2);
  expect(body).toEqual({
    services: expect.arrayContaining(
      positions.map(({ id, x, y }, index) => ({
        id,
        name: `Layout service ${index}`,
        presentation: {
          groupName: `Layout service ${index}`,
          groupColor: "neutral",
          componentNames: {},
          positions: { "": { x, y, revision: 1 } },
        },
      })),
    ),
  });
});

test("malformed batches and late invalid entries do not change any positions or layout audits", async () => {
  const f = await setup();
  await f.browser.request(`/services/${f.group}/presentation`, {
    position: { x: 100, y: 200 },
  });
  await f.browser.request(`/services/${f.group}/presentation`, {
    position: { component: "database", x: 300, y: 400 },
  });
  const before = await layoutState(f.sql);
  const first = { id: f.group, x: 500, y: 600 };
  const second = { id: f.ordinary, x: 700, y: 800 };
  for (const body of [
    null,
    [],
    "positions",
    {},
    { positions: null },
    { positions: {} },
    { positions: [] },
    { positions: [first], extra: true },
    ...[
      null,
      [],
      false,
      "position",
      {},
      { x: 0, y: 0 },
      { ...second, id: null },
      { ...second, id: "not-a-service-id" },
      { ...second, id: f.ordinary.toUpperCase() },
      { ...second, x: undefined },
      { ...second, y: undefined },
      { ...second, x: "24" },
      { ...second, y: null },
      { ...second, x: -1 },
      { ...second, y: -0.1 },
      { ...second, x: 20000.1 },
      { ...second, y: 20001 },
      { ...second, component: "" },
      { ...second, component: "database" },
      { ...second, revision: 9 },
      { ...second, extra: true },
    ].map((invalid) => ({ positions: [first, invalid] })),
    { positions: [first, { ...first, x: 900 }] },
  ]) {
    const response = await f.browser.request(endpoint, body);
    expect(response.status).toBe(400);
    expect(await layoutState(f.sql)).toEqual(before);
  }
  for (const coordinate of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    for (const axis of ["x", "y"]) {
      await expect(
        updateMapPositions(f.sql, {
          positions: [first, { ...second, [axis]: coordinate }],
        }),
      ).rejects.toThrow("INVALID_MAP_POSITION");
      expect(await layoutState(f.sql)).toEqual(before);
    }
  }
});

test("every service must exist before any root is written", async () => {
  const f = await setup();
  const before = await layoutState(f.sql);
  const response = await f.browser.request(endpoint, {
    positions: [
      { id: f.group, x: 24, y: 48 },
      { id: crypto.randomUUID(), x: 96, y: 120 },
      { id: f.ordinary, x: 144, y: 168 },
    ],
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "SERVICE_NOT_FOUND" });
  expect(await layoutState(f.sql)).toEqual(before);
});

test("a concurrent service deletion rolls back the entire root upsert, including revisions", async () => {
  const f = await setup();
  await f.browser.request(`/services/${f.group}/presentation`, {
    position: { x: 12, y: 34 },
  });
  const before = await layoutState(f.sql);
  const sql: Sql = {
    async query<T extends Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      if (text.startsWith("INSERT INTO ephor_service_map_position")) {
        await f.sql.query(
          "DELETE FROM ephor_service_domain WHERE service_id=$1",
          [f.ordinary],
        );
        await f.sql.query("DELETE FROM ephor_service WHERE id=$1", [
          f.ordinary,
        ]);
      }
      return f.sql.query<T>(text, values);
    },
  };
  await expect(
    updateMapPositions(sql, {
      positions: [
        { id: f.group, x: 1000, y: 2000 },
        { id: f.ordinary, x: 3000, y: 4000 },
      ],
    }),
  ).rejects.toThrow();
  expect(await layoutState(f.sql)).toEqual(before);
});

test("batch accepts 32 roots across machines within D1's parameter limit and rejects 33 atomically", async () => {
  const f = await setup(32);
  const positions = f.ids.map((id, index) => ({
    id,
    x: index * 24,
    y: 20000 - index * 24,
  }));
  expect(JSON.stringify({ positions }).length).toBeLessThan(32 * 1024);
  const queries: { text: string; values: unknown[] }[] = [];
  const sql: Sql = {
    async query<T extends Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      queries.push({ text, values });
      return f.sql.query<T>(text, values);
    },
  };
  const body = await updateMapPositions(sql, { positions });
  expect(body.services).toHaveLength(32);
  for (const { text, values } of queries) {
    expect(values.length).toBeLessThanOrEqual(100);
    // The D1 adapter binds each placeholder occurrence, not just unique indexes.
    expect(text.match(/\$\d+/g)?.length ?? 0).toBeLessThanOrEqual(100);
  }
  expect(
    queries.find(({ text }) =>
      text.startsWith("INSERT INTO ephor_service_map_position"),
    )?.values,
  ).toHaveLength(96);
  const current = await f.services.list(undefined, true);
  for (const position of positions) {
    expect(
      current.find((service) => service.id === position.id)?.presentation
        .positions?.[""],
    ).toEqual({ x: position.x, y: position.y, revision: 1 });
  }
  const before = await layoutState(f.sql);
  const tooMany = await f.browser.request(endpoint, {
    positions: [...positions, { id: crypto.randomUUID(), x: 0, y: 0 }],
  });
  expect(tooMany.status).toBe(400);
  expect(await tooMany.json()).toEqual({ code: "INVALID_MAP_POSITION" });
  expect(await layoutState(f.sql)).toEqual(before);
});

test("batch activity describes arranging services without a single service target", async () => {
  const f = await setup();
  const positions = [
    { id: f.group, x: 24, y: 48 },
    { id: f.ordinary, x: 96, y: 120 },
  ];
  expect(
    describeActivity(`/api${endpoint}`, { id: f.group, positions }),
  ).toEqual({
    action: "Arrange services on map",
    type: "service",
  });
  expect((await f.browser.request(endpoint, { positions })).status).toBe(200);
  const response = await f.browser.request("/activity?category=services");
  expect(response.status).toBe(200);
  const history: ActivityList = await response.json();
  const arranged = history.items.filter(
    (item) => item.action === "Arrange services on map",
  );
  expect(arranged).toHaveLength(1);
  expect(arranged[0]).toMatchObject({
    category: "services",
    outcome: "succeeded",
    status: 200,
  });
  expect(arranged[0]?.target).toEqual({
    id: null,
    name: null,
    type: "service",
  });
});

test("batch inherits owner and same-origin checks without requiring fresh authentication", async () => {
  const f = await setup();
  const body = { positions: [{ id: f.group, x: 72, y: 96 }] };
  const before = await layoutState(f.sql);
  expect((await new Browser(f.app).request(endpoint, body)).status).toBe(401);
  expect(
    (await f.browser.request(endpoint, body, { origin: "https://evil.test" }))
      .status,
  ).toBe(403);
  expect((await f.browser.request(endpoint, body, { origin: "" })).status).toBe(
    403,
  );
  expect(
    (
      await f.browser.request(endpoint, body, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(await layoutState(f.sql)).toEqual(before);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect((await f.browser.request(endpoint, body)).status).toBe(200);
  expect(
    (await f.browser.request("/services/cancel", { id: f.group })).status,
  ).toBe(403);
  expect(
    (
      await f.browser.request(`/services/${f.group}/presentation`, {
        position: { x: 120, y: 144 },
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.services.list(f.group, true))[0]?.presentation.positions?.[""],
  ).toEqual({ x: 120, y: 144, revision: 2 });
});
