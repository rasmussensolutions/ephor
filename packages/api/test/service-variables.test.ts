import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { catalogConfig } from "../src/services/catalog";
import type { ServiceSpec } from "../src/services/spec";
import { Services } from "../src/services/store";
import { ServiceVariables } from "../src/services/variables";
import { enrolled, fixture, timestamp } from "./helpers";

const config = {
  image: "docker.io/library/nginx:latest",
  port: 3000,
  healthPath: "/health",
  memoryMb: 256,
  cpus: 0.5,
  environment: { TOKEN: "test-secret-value", KEEP: "preserved" },
  registry: {
    server: "docker.io",
    username: "reader",
    password: "registry-secret",
  },
};
async function setup(authenticated?: Awaited<ReturnType<typeof fixture>>) {
  const f = authenticated ?? (await fixture());
  const machines = new MachineStore(f.sql),
    services = new Services(f.sql, f.env.secret),
    variables = new ServiceVariables(f.sql, f.env.secret);
  const machine = await machines.create("variables-test");
  await machines.enroll(machine.token, randomToken());
  const service = await services.create(
    { machineId: machine.id, name: "web", spec: config },
    { type: "image" },
  );
  return { ...f, services, variables, id: service.id, machineId: machine.id };
}
test("variable patches preserve unrelated settings and keep values out of reads and storage", async () => {
  const f = await setup();
  const before = await f.variables.list(f.id);
  expect(before.names).toEqual(["KEEP", "TOKEN"]);
  expect(JSON.stringify(before)).not.toContain("test-secret-value");
  const saved = await f.variables.update(f.id, {
    revision: before.revision,
    set: { TOKEN: "replacement", EMPTY: "" },
    remove: ["KEEP"],
  });
  expect(saved.names).toEqual(["EMPTY", "TOKEN"]);
  const row = await f.services.get(f.id);
  expect(row.config).not.toContain("replacement");
  const decoded = await f.services.secrets.open<ServiceSpec>(f.id, row.config);
  expect(decoded).toEqual({
    ...config,
    environment: { TOKEN: "replacement", EMPTY: "" },
  });
  expect(
    await f.variables.reveal(f.id, { revision: saved.revision, name: "TOKEN" }),
  ).toEqual({ values: { TOKEN: "replacement" } });
  expect(await f.variables.reveal(f.id, { revision: saved.revision })).toEqual({
    values: { TOKEN: "replacement", EMPTY: "" },
  });
  const audit = await f.sql.query("SELECT * FROM ephor_auth_audit");
  expect(JSON.stringify(audit)).not.toContain("replacement");
  expect(JSON.stringify(await f.services.list())).not.toContain("replacement");
});
test("stale and concurrent variable writes cannot silently overwrite newer configuration", async () => {
  const f = await setup(),
    before = await f.variables.list(f.id);
  const results = await Promise.allSettled([
    f.variables.update(f.id, { revision: before.revision, set: { ONE: "1" } }),
    f.variables.update(f.id, { revision: before.revision, set: { TWO: "2" } }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  await expect(
    f.variables.update(f.id, { revision: before.revision, remove: ["TOKEN"] }),
  ).rejects.toThrow("VARIABLES_CHANGED");
  await expect(
    f.variables.reveal(f.id, { revision: before.revision }),
  ).rejects.toThrow("VARIABLES_CHANGED");
});
test("invalid variables and catalog edits leave encrypted configuration unchanged", async () => {
  const f = await setup(),
    before = await f.variables.list(f.id),
    row = await f.services.get(f.id);
  for (const patch of [
    { set: { "BAD-KEY": "x" } },
    { set: { TOKEN: 1 } },
    { set: { TOKEN: "x".repeat(4097) } },
    { remove: "TOKEN" },
    { remove: [null] },
    {
      set: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`KEY_${i}`, "value"]),
      ),
    },
  ])
    await expect(
      f.variables.update(f.id, { revision: before.revision, ...patch }),
    ).rejects.toThrow();
  expect((await f.services.get(f.id)).config).toBe(row.config);
  const catalog = catalogConfig("postgres");
  const service = await f.services.create(
    { machineId: f.machineId, name: "database", spec: catalog.config },
    catalog.source,
  );
  const metadata = await f.variables.list(service.id);
  expect(metadata.editable).toBe(false);
  await expect(
    f.variables.update(service.id, {
      revision: metadata.revision,
      set: { TOKEN: "x" },
    }),
  ).rejects.toThrow("CATALOG_CONFIG_LOCKED");
});
test("variable routes enforce owner authentication, fresh passkeys and same-origin writes", async () => {
  const authenticated = await enrolled();
  const f = await setup(authenticated);
  const browser = authenticated.browser;
  const path = `/services/${f.id}/variables`;
  expect((await f.app.request(`/api${path}`)).status).toBe(401);
  const metadata = await browser.request(path);
  expect(metadata.status).toBe(200);
  expect(metadata.headers.get("cache-control")).toBe("no-store");
  const { revision } = await metadata.json();
  expect(
    (await browser.request(`${path}/reveal`, { revision, name: "TOKEN" }))
      .status,
  ).toBe(200);
  expect(
    (
      await browser.request(
        path,
        { revision, set: { NEW: "value" } },
        { origin: "https://untrusted.example" },
      )
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect((await browser.request(`${path}/reveal`, { revision })).status).toBe(
    403,
  );
  expect(
    (await browser.request(path, { revision, set: { NEW: "value" } })).status,
  ).toBe(403);
});
