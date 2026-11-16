import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { catalogConfig } from "../src/services/catalog";
import {
  referenceValue,
  ServiceConnections,
} from "../src/services/connections";
import { type ServiceSpec, spec } from "../src/services/spec";
import { Services } from "../src/services/store";
import { ServiceVariables } from "../src/services/variables";
import { fixture } from "./helpers";

async function setup() {
  const f = await fixture();
  const services = new Services(f.sql, f.env.secret);
  const variables = new ServiceVariables(f.sql, f.env.secret);
  const machines = new MachineStore(f.sql);
  async function machine() {
    const m = await machines.create("connections");
    await machines.enroll(m.token, randomToken());
    await services.enroll(await services.issueWorker(m.id), randomToken());
    await services.heartbeat(m.id, 5);
    return m.id;
  }
  const machineId = await machine();
  async function database(template: string, destination = machineId) {
    const c = catalogConfig(template);
    const service = await services.create(
      { machineId: destination, name: template, spec: c.config },
      c.source,
    );
    return { id: service.id, config: c.config };
  }
  const postgres = await database("postgres");
  const redis = await database("redis");
  const app = await services.create(
    {
      machineId,
      name: "web",
      spec: {
        image: "docker.io/library/nginx:latest",
        environment: { KEEP: "literal" },
      },
    },
    { type: "image" },
  );
  return {
    ...f,
    services,
    variables,
    machine,
    machineId,
    database,
    postgres,
    redis,
    app,
    connections: new ServiceConnections(f.sql, services.secrets),
  };
}

test("suggestions include only same-machine standalone databases and never credentials", async () => {
  const f = await setup();
  await f.database("postgres", await f.machine());
  await f.database("umami");
  const metadata = await f.variables.list(f.app.id);
  expect(metadata.suggestions.map((s) => s.serviceId).sort()).toEqual(
    [f.postgres.id, f.redis.id].sort(),
  );
  expect(JSON.stringify(metadata)).not.toContain(
    f.postgres.config.environment.DB_PASSWORD as string,
  );
  expect((await f.variables.list(f.postgres.id)).suggestions).toEqual([]);
});

test("linked variables resolve into private URLs only in encrypted deployment snapshots and rollback retains them", async () => {
  const f = await setup();
  const ref = referenceValue(f.postgres.id, "DATABASE_URL");
  const before = await f.variables.list(f.app.id);
  const saved = await f.variables.update(f.app.id, {
    revision: before.revision,
    set: {
      DATABASE_URL: ref,
      SECOND_DATABASE: ref,
      CACHE_URL: referenceValue(f.redis.id, "REDIS_URL"),
    },
  });
  expect(saved.references.DATABASE_URL?.value).toBe(ref);
  expect(
    (await f.variables.reveal(f.app.id, { revision: saved.revision })).values
      .DATABASE_URL,
  ).toBe(ref);
  const queued = await f.services.queue(f.app.id, "deploy");
  expect(await f.services.next(f.machineId, 4)).toBeNull();
  const job = await f.services.next(f.machineId, 5);
  expect(job?.id).toBe(queued.id);
  expect(job?.spec.connections).toHaveLength(2);
  expect(job?.spec.environment.DATABASE_URL).toBe(
    `postgresql://ephor:${f.postgres.config.environment.DB_PASSWORD}@ephor-app-${f.postgres.id}-database:5432/app`,
  );
  expect(job?.spec.environment.CACHE_URL).toContain(
    `@ephor-app-${f.redis.id}-redis:6379/0`,
  );
  expect(job?.spec.environment.KEEP).toBe("literal");
  const original = job?.spec.environment.DATABASE_URL;
  await f.services.report(f.machineId, {
    id: queued.id,
    status: "succeeded",
    digest: `docker.io/library/nginx@sha256:${"a".repeat(64)}`,
  });
  const rotated = {
    ...f.postgres.config,
    environment: { DB_PASSWORD: "new:pass/@word" },
  };
  await f.sql.query("UPDATE ephor_service SET config=$1 WHERE id=$2", [
    await f.services.secrets.seal(f.postgres.id, rotated),
    f.postgres.id,
  ]);
  const next = await f.services.queue(f.app.id, "deploy");
  const resolved = await f.services.next(f.machineId, 5);
  expect(resolved?.spec.environment.DATABASE_URL).toContain(
    "new%3Apass%2F%40word@",
  );
  await f.services.report(f.machineId, { id: next.id, status: "failed" });
  await f.services.queue(f.app.id, "rollback", { deploymentId: queued.id });
  const rollback = await f.services.next(f.machineId, 5);
  expect(rollback?.spec.environment.DATABASE_URL).toBe(original);
  expect(rollback?.spec.connections).toEqual(job?.spec.connections);
  const ordinary = JSON.stringify([
    await f.services.list(),
    await f.services.history(),
    await f.variables.list(f.app.id),
    await f.sql.query("SELECT spec FROM ephor_deployment"),
    await f.sql.query("SELECT * FROM ephor_auth_audit"),
  ]);
  expect(ordinary).not.toContain(
    f.postgres.config.environment.DB_PASSWORD as string,
  );
  expect(ordinary).not.toContain("new%3Apass");
});

test("invalid, cross-machine and recursive references fail without changing settings", async () => {
  const f = await setup();
  const remote = await f.database("postgres", await f.machine());
  const before = await f.variables.list(f.app.id);
  for (const value of [
    referenceValue(remote.id, "DATABASE_URL"),
    referenceValue(f.app.id, "DATABASE_URL"),
    referenceValue(f.postgres.id, "REDIS_URL"),
    referenceValue(crypto.randomUUID(), "DATABASE_URL"),
    `prefix${referenceValue(f.postgres.id, "DATABASE_URL")}`,
    `\${{bad.DATABASE_URL}}`,
  ]) {
    await expect(
      f.variables.update(f.app.id, {
        revision: before.revision,
        set: { DATABASE_URL: value },
      }),
    ).rejects.toThrow();
  }
  expect((await f.variables.list(f.app.id)).revision).toBe(before.revision);
  expect(
    spec({
      image: "docker.io/library/nginx:latest",
      connections: [{ serviceId: remote.id, template: "postgres" }],
    }).connections,
  ).toBeUndefined();
});

test("old workers are blocked and removing a link removes its network grant; stop survives a missing source", async () => {
  const f = await setup();
  const before = await f.variables.list(f.app.id);
  const saved = await f.variables.update(f.app.id, {
    revision: before.revision,
    set: { DATABASE_URL: referenceValue(f.postgres.id, "DATABASE_URL") },
  });
  await f.services.heartbeat(f.machineId, 4);
  await expect(f.services.queue(f.app.id, "deploy")).rejects.toThrow(
    "CONNECTION_WORKER_REQUIRED",
  );
  await f.variables.update(f.app.id, {
    revision: saved.revision,
    remove: ["DATABASE_URL"],
  });
  await f.services.queue(f.app.id, "deploy");
  const unlinked = await f.services.next(f.machineId, 4);
  expect(unlinked?.spec.connections).toBeUndefined();
  await f.services.report(f.machineId, { id: unlinked?.id, status: "failed" });
  const config = await f.services.secrets.open<ServiceSpec>(
    f.app.id,
    (await f.services.get(f.app.id)).config,
  );
  config.environment.DATABASE_URL = referenceValue(
    crypto.randomUUID(),
    "DATABASE_URL",
  );
  await f.sql.query("UPDATE ephor_service SET config=$1 WHERE id=$2", [
    await f.services.secrets.seal(f.app.id, config),
    f.app.id,
  ]);
  await expect(f.services.queue(f.app.id, "deploy")).rejects.toThrow(
    "CONNECTION_SOURCE_UNAVAILABLE",
  );
  // A broken dependency must never prevent stopping the app.
  await expect(f.services.queue(f.app.id, "stop")).resolves.toHaveProperty(
    "id",
  );
});

test("saved links appear in map metadata immediately and stay pending until the matching deployment succeeds", async () => {
  const f = await setup();
  const metadata = async () => (await f.services.list(f.app.id, true))[0];
  const deploy = async () => {
    const queued = await f.services.queue(f.app.id, "deploy");
    await f.services.next(f.machineId, 5);
    return queued.id;
  };
  const report = (id: string) =>
    f.services.report(f.machineId, {
      id,
      status: "succeeded",
      digest: `docker.io/library/nginx@sha256:${"a".repeat(64)}`,
    });
  await report(await deploy());
  expect((await metadata())?.variablesPending).toBe(false);
  const before = await f.variables.list(f.app.id);
  const linked = await f.variables.update(f.app.id, {
    revision: before.revision,
    set: {
      DATABASE_URL: referenceValue(f.postgres.id, "DATABASE_URL"),
      OTHER_URL: referenceValue(f.postgres.id, "DATABASE_URL"),
    },
  });
  expect((await metadata())?.variableConnections).toEqual([
    { serviceId: f.postgres.id, variables: ["DATABASE_URL", "OTHER_URL"] },
  ]);
  expect((await metadata())?.variablesPending).toBe(true);
  const first = await deploy();
  expect((await metadata())?.variablesPending).toBe(true);
  // Saving again during a deployment must not be falsely marked applied.
  const newer = await f.variables.update(f.app.id, {
    revision: linked.revision,
    set: { KEEP: "new-value" },
  });
  await report(first);
  expect((await metadata())?.variablesPending).toBe(true);
  const failed = await deploy();
  await f.services.report(f.machineId, { id: failed, status: "failed" });
  expect((await metadata())?.variablesPending).toBe(true);
  await report(await deploy());
  expect((await metadata())?.variablesPending).toBe(false);
  expect(JSON.stringify(await metadata())).not.toContain("new-value");
  expect(JSON.stringify(await metadata())).not.toContain(
    f.postgres.config.environment.DB_PASSWORD as string,
  );
  await f.variables.update(f.app.id, {
    revision: newer.revision,
    remove: ["DATABASE_URL", "OTHER_URL"],
  });
  expect((await metadata())?.variableConnections).toEqual([]);
  expect((await metadata())?.variablesPending).toBe(true);
  await report(await deploy());
  expect((await metadata())?.variablesPending).toBe(false);
});

test("pending comparison detects a network grant even when literal and linked URLs resolve identically", async () => {
  const f = await setup();
  const row = await f.services.get(f.app.id);
  const config = spec({
    image: "docker.io/library/nginx:latest",
    environment: {
      DATABASE_URL: referenceValue(f.postgres.id, "DATABASE_URL"),
    },
  });
  const deployed = await f.connections.resolve(row, config);
  expect(await f.connections.pending(row, config, deployed)).toBe(false);
  delete deployed.connections;
  expect(await f.connections.pending(row, config, deployed)).toBe(true);
});
