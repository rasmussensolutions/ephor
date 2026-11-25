import { expect, test } from "bun:test";
import { createApi } from "../src";
import { randomToken } from "../src/auth/store";
import { Backups } from "../src/backups/store";
import { MachineStore } from "../src/machines/store";
import { catalogConfig } from "../src/services/catalog";
import {
  referenceValue,
  ServiceConnections,
} from "../src/services/connections";
import { reserveDomains } from "../src/services/domains";
import { spec } from "../src/services/spec";
import { Services } from "../src/services/store";
import { Browser, enrolled, timestamp } from "./helpers";

const config = {
  image: "docker.io/library/busybox:1.37",
  volumes: [{ name: "data", mountPath: "/data" }],
  environment: { TOKEN: "original-secret" },
};
async function setup() {
  const f = await enrolled();
  const services = new Services(f.sql, f.env.secret),
    backups = new Backups(f.sql, f.env.secret);
  const machine = await new MachineStore(f.sql).create("persistent");
  await new MachineStore(f.sql).enroll(machine.token, randomToken());
  await services.enroll(await services.issueWorker(machine.id), randomToken());
  await services.heartbeat(machine.id, 6);
  await f.sql.query("UPDATE ephor_machine SET telemetry=$1 WHERE id=$2", [
    JSON.stringify({ arch: "x86_64" }),
    machine.id,
  ]);
  const app = await services.create(
    { machineId: machine.id, name: "Persistent", spec: config },
    { type: "image" },
  );
  return { ...f, api: f.app, services, backups, machine, app };
}
test("managed volumes reject host mounts, reserved paths, traversal and overlaps", () => {
  for (const volumes of [
    ["/:/host"],
    [{ name: "data", mountPath: "/etc" }],
    [{ name: "data", mountPath: "/var/lib/docker/data" }],
    [{ name: "../bad", mountPath: "/data" }],
    [{ name: "data", mountPath: "/data/../etc" }],
    [{ name: "data", mountPath: "/data", source: "/host" }],
    [
      { name: "a", mountPath: "/data" },
      { name: "b", mountPath: "/data/sub" },
    ],
  ])
    expect(() => spec({ ...config, volumes })).toThrow();
  expect(spec(config).volumes).toEqual(config.volumes);
  expect(spec({ ...config, volumes: [] })).not.toHaveProperty("volumes");
});
test("storage edits are saved separately and require a protocol-7 worker", async () => {
  const f = await setup();
  await f.services.heartbeat(f.machine.id, 5);
  await expect(f.services.queue(f.app.id, "deploy")).rejects.toThrow(
    "STATEFUL_WORKER_REQUIRED",
  );
  await f.services.heartbeat(f.machine.id, 6);
  await f.services.queue(f.app.id, "deploy");
  expect(await f.services.next(f.machine.id, 5)).toBeNull();
  expect((await f.services.next(f.machine.id, 6))?.spec.volumes).toEqual(
    config.volumes,
  );
  await f.services.configure(f.app.id, { spec: { ...config, volumes: [] } });
  await expect(f.services.queue(f.app.id, "deploy")).rejects.toThrow(
    "STATEFUL_WORKER_REQUIRED",
  );
  await f.services.report(f.machine.id, {
    id: (await f.services.history(f.app.id))[0]?.id,
    status: "succeeded",
    digest: `docker.io/library/busybox@sha256:${"a".repeat(64)}`,
  });
  await f.services.heartbeat(f.machine.id, 7);
  await f.services.queue(f.app.id, "deploy");
  expect(await f.services.next(f.machine.id, 6)).toBeNull();
  const edited = await f.services.next(f.machine.id, 7);
  expect(edited?.spec.storageVersion).toBe(1);
  expect(edited?.spec.volumes).toBeUndefined();
  await expect(f.services.queue(f.app.id, "rollback")).rejects.toThrow(
    "STATEFUL_ROLLBACK_BLOCKED",
  );
});
test("existing stateless services can attach, remount, detach and reattach storage without losing secrets", async () => {
  const f = await setup();
  const app = await f.services.create(
    {
      machineId: f.machine.id,
      name: "Existing",
      spec: { ...config, volumes: [] },
    },
    { type: "image" },
  );
  const deployed = await f.services.queue(app.id, "deploy");
  await f.services.next(f.machine.id, 6);
  await f.services.report(f.machine.id, {
    id: deployed.id,
    status: "succeeded",
    digest: `docker.io/library/busybox@sha256:${"a".repeat(64)}`,
  });
  for (const volumes of [
    config.volumes,
    [
      { name: "data", mountPath: "/app/data" },
      { name: "cache", mountPath: "/cache" },
    ],
    [],
    config.volumes,
  ]) {
    await f.services.configure(app.id, {
      spec: { image: config.image, volumes },
    });
    const row = await f.services.get(app.id);
    const saved = await f.services.secrets.open<ReturnType<typeof spec>>(
      row.id,
      row.config,
    );
    expect(saved.storageVersion).toBe(1);
    expect(saved.volumes ?? []).toEqual(
      spec({ ...config, volumes }).volumes ?? [],
    );
    expect(saved.environment).toEqual(config.environment);
    expect(row.current_deployment).toBe(deployed.id);
  }
  await f.services.configure(app.id, { spec: { image: config.image } });
  expect((await f.services.list(app.id))[0]?.requiredWorkerProtocol).toBe(7);
  // Stop still targets what actually runs, not pending mounts or variables.
  await f.services.queue(app.id, "stop");
  expect(
    (await f.services.next(f.machine.id, 6))?.spec.volumes,
  ).toBeUndefined();
});
test("worker upgrade verifies protocol-6 release before issuing an enrollment credential", async () => {
  const f = await setup();
  for (const serviceProtocol of [5, 6]) {
    const api = createApi({
      ...f.env,
      loadDaemonRelease: async () => ({
        x86_64: "a".repeat(64),
        aarch64: "b".repeat(64),
        serviceProtocol,
      }),
    });
    const browser = new Browser(api);
    browser.cookies = new Map(f.browser.cookies);
    const response = await browser.request("/services/worker", {
      machineId: f.machine.id,
      minimumProtocol: 6,
    });
    expect(response.status).toBe(serviceProtocol === 6 ? 200 : 409);
    if (serviceProtocol === 5)
      expect(await response.json()).toMatchObject({
        code: "SERVICE_BUILD_REQUIRED",
      });
  }
});
test("custom backups freeze deployed settings and restore privately without production network grants", async () => {
  const f = await setup();
  const deployment = await f.services.queue(f.app.id, "deploy");
  await f.services.next(f.machine.id, 6);
  const digest = `docker.io/library/busybox@sha256:${"a".repeat(64)}`;
  await f.services.report(f.machine.id, {
    id: deployment.id,
    status: "succeeded",
    digest,
  });
  await f.services.configure(f.app.id, {
    spec: { ...config, environment: { TOKEN: "pending-secret" } },
  });
  await reserveDomains(f.sql, f.app.id, {
    primary: "pending.example.com",
    aliases: [],
    redirect: false,
  });
  const destination = await f.backups.createDestination({
    machineId: f.machine.id,
    name: "Storage",
    provider: "r2",
    accountId: "a".repeat(32),
    bucket: "ephor-test",
    accessKey: "test-access",
    secretKey: "test-secret",
  });
  const check = await f.backups.next(f.machine.id, 6);
  await f.backups.report(f.machine.id, { id: check?.id, status: "succeeded" });
  const plan = await f.backups.configure({
    serviceId: f.app.id,
    destinationId: destination.id,
    frequency: "manual",
    hour: 0,
  });
  const backup = await f.backups.queue(plan.id);
  expect(await f.backups.next(f.machine.id, 5)).toBeNull();
  const task = await f.backups.next(f.machine.id, 6);
  expect(task?.job?.spec.image).toBe(digest);
  expect(task?.job?.spec.environment.TOKEN).toBe("original-secret");
  expect(task?.job?.domain).toBeNull();
  expect(task?.job?.domains.primary).toBeNull();
  await f.backups.report(f.machine.id, {
    id: backup.id,
    status: "succeeded",
    snapshot: "b".repeat(64),
  });
  await f.services.heartbeat(f.machine.id, 6);
  const restored = await f.backups.restore({
    backupId: backup.id,
    machineId: f.machine.id,
    name: "Recovered",
  });
  expect(restored.serviceId).not.toBe(f.app.id);
  const row = await f.services.get(restored.serviceId);
  expect(row.domain).toBeNull();
  expect(JSON.parse(row.source).type).toBe("image");
  const saved = await f.services.secrets.open<{
    image: string;
    environment: Record<string, string>;
  }>(row.id, row.config);
  expect(saved.image).toBe(digest);
  expect(saved.environment.TOKEN).toBe("original-secret");
  expect((await f.services.get(f.app.id)).current_deployment).toBe(
    deployment.id,
  );
  await f.backups.next(f.machine.id, 6);
  await f.backups.report(f.machine.id, {
    id: restored.id,
    status: "succeeded",
  });
  await f.services.configure(row.id, {
    spec: { ...config, environment: { TOKEN: "unsaved-to-runtime" } },
  });
  await reserveDomains(f.sql, row.id, {
    primary: "recovered.example.com",
    aliases: [],
    redirect: false,
  });
  const stop = await f.services.queue(row.id, "stop");
  const stopJob = await f.services.next(f.machine.id, 6);
  expect(stopJob?.id).toBe(stop.id);
  expect(stopJob?.spec.environment.TOKEN).toBe("original-secret");
  expect(stopJob?.spec.image).toBe(digest);
  expect(stopJob?.domain).toBeNull();
});
test("database sizing is validated, authenticated and does not silently restart", async () => {
  const f = await setup();
  const db = catalogConfig("redis");
  const { id } = await f.services.create(
    { machineId: f.machine.id, name: "Redis", spec: db.config },
    db.source,
  );
  expect(
    (
      await f.api.request(`/api/services/${id}/resources`, {
        method: "POST",
        body: JSON.stringify({
          memoryMb: 1024,
          cpus: 2,
          redisMaxmemoryMb: 512,
        }),
      })
    ).status,
  ).toBe(403);
  await expect(
    f.services.resources(id, { memoryMb: 128, cpus: 1, redisMaxmemoryMb: 120 }),
  ).rejects.toThrow("INVALID_DATABASE_RESOURCES");
  await f.services.resources(id, {
    memoryMb: 1024,
    cpus: 2,
    redisMaxmemoryMb: 512,
  });
  expect((await f.services.list(id))[0]?.spec.memoryMb).toBe(1024);
  expect((await f.services.list(id))[0]?.resourcesPending).toBe(true);
  expect(await f.services.history(id)).toHaveLength(0);
  const deployment = await f.services.queue(id, "deploy");
  await f.services.next(f.machine.id, 6);
  await f.services.report(f.machine.id, {
    id: deployment.id,
    status: "succeeded",
    digest: db.config.image,
  });
  expect((await f.services.list(id))[0]?.resourcesPending).toBe(false);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [timestamp(0)]);
  expect(
    (
      await f.browser.request(`/services/${id}/resources`, {
        memoryMb: 1024,
        cpus: 2,
        redisMaxmemoryMb: 512,
      })
    ).status,
  ).toBe(403);
});
test("Qdrant exports private HTTP/gRPC and masked API-key references", async () => {
  const f = await setup();
  const db = catalogConfig("qdrant");
  const { id } = await f.services.create(
    { machineId: f.machine.id, name: "Qdrant", spec: db.config },
    db.source,
  );
  const connections = new ServiceConnections(f.sql, f.services.secrets);
  const resolved = await connections.resolve(
    { id: f.app.id, machine_id: f.machine.id },
    spec({
      ...config,
      environment: {
        QDRANT_URL: referenceValue(id, "QDRANT_URL"),
        QDRANT_GRPC_URL: referenceValue(id, "QDRANT_GRPC_URL"),
        QDRANT_API_KEY: referenceValue(id, "QDRANT_API_KEY"),
      },
    }),
  );
  expect(resolved.environment.QDRANT_URL).toBe(
    `http://ephor-app-${id}-qdrant:6333`,
  );
  expect(resolved.environment.QDRANT_GRPC_URL).toBe(
    `http://ephor-app-${id}-qdrant:6334`,
  );
  expect(resolved.environment.QDRANT_API_KEY).toBe(
    db.config.environment.API_KEY,
  );
  expect(JSON.stringify(await f.services.list(id))).not.toContain(
    db.config.environment.API_KEY as string,
  );
});
