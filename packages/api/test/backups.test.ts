import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { destinationConfig, nextRun } from "../src/backups/providers";
import { Backups } from "../src/backups/store";
import { MachineStore } from "../src/machines/store";
import { catalogConfig } from "../src/services/catalog";
import { Services } from "../src/services/store";
import { enrolled, timestamp } from "./helpers";

async function setup() {
  const f = await enrolled(),
    services = new Services(f.sql, f.env.secret),
    backups = new Backups(f.sql, f.env.secret),
    machines = new MachineStore(f.sql);
  async function machine(name: string) {
    const m = await machines.create(name),
      token = randomToken();
    await machines.enroll(m.token, randomToken());
    await services.enroll(await services.issueWorker(m.id), token);
    await services.heartbeat(m.id, 4);
    await f.sql.query("UPDATE ephor_machine SET telemetry=$1 WHERE id=$2", [
      JSON.stringify({ arch: "x86_64" }),
      m.id,
    ]);
    return { ...m, token };
  }
  const source = await machine("source"),
    target = await machine("target");
  const cfg = catalogConfig("postgres");
  const service = await services.create(
    { machineId: source.id, name: "Database", spec: cfg.config },
    cfg.source,
  );
  const deploy = await services.queue(service.id, "deploy");
  await services.next(source.id, 4);
  await services.report(source.id, {
    id: deploy.id,
    status: "succeeded",
    digest: cfg.config.image,
  });
  return { ...f, services, backups, source, target, service, cfg };
}
const storage = {
  provider: "r2",
  accountId: "a".repeat(32),
  bucket: "ephor-backups",
  accessKey: "test-access-key",
  secretKey: "test-secret-key",
  name: "R2 backups",
};
async function configured(patch: Record<string, unknown> = {}) {
  const f = await setup();
  const destination = await f.backups.createDestination({
    ...storage,
    ...patch,
    machineId: f.source.id,
  });
  const check = await f.backups.next(f.source.id, 4);
  expect(check?.action).toBe("check");
  await f.backups.report(f.source.id, { id: check?.id, status: "succeeded" });
  const plan = await f.backups.configure({
    serviceId: f.service.id,
    destinationId: destination.id,
    frequency: "daily",
    hour: 2,
  });
  return { ...f, destination, plan };
}
test("provider endpoints are derived, HTTPS-only and reject injection", () => {
  expect(destinationConfig(storage).endpoint).toBe(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
  );
  expect(
    destinationConfig({ ...storage, provider: "b2", region: "eu-central-003" })
      .endpoint,
  ).toBe("https://s3.eu-central-003.backblazeb2.com");
  for (const jurisdiction of ["eu", "us", "fedramp"])
    expect(destinationConfig({ ...storage, jurisdiction }).endpoint).toBe(
      `https://${"a".repeat(32)}.${jurisdiction}.r2.cloudflarestorage.com`,
    );
  for (const patch of [
    { jurisdiction: "eu.evil.test/" },
    { jurisdiction: "unsupported" },
    { provider: "custom", endpoint: "http://169.254.169.254" },
    { accountId: "localhost" },
    { provider: "b2", region: "us-west-004/../../" },
    { bucket: "../other" },
    { secretKey: "secret\nAWS_CONFIG_FILE=x" },
  ])
    expect(() => destinationConfig({ ...storage, ...patch })).toThrow();
});
test("UTC schedules advance at boundaries and weekly schedules run on Sunday", () => {
  const now = Date.parse("2026-11-14T02:00:00Z");
  expect(nextRun("daily", 2, now)).toBe(Date.parse("2026-11-15T02:00:00Z"));
  expect(nextRun("weekly", 2, now)).toBe(Date.parse("2026-11-15T02:00:00Z"));
  expect(nextRun("weekly", 2, Date.parse("2026-11-15T02:00:00Z"))).toBe(
    Date.parse("2026-11-22T02:00:00Z"),
  );
  expect(nextRun("manual", 2, now)).toBe(0);
});
test("destinations stay unverified until the assigned worker checks them; credentials are encrypted and redacted", async () => {
  const f = await setup();
  const d = await f.backups.createDestination({
    ...storage,
    machineId: f.source.id,
  });
  await expect(
    f.backups.configure({ serviceId: f.service.id, destinationId: d.id }),
  ).rejects.toThrow("BACKUP_DESTINATION_NOT_READY");
  expect(await f.backups.next(f.target.id, 4)).toBeNull();
  const check = await f.backups.next(f.source.id, 4);
  await expect(
    f.backups.report(f.target.id, { id: check?.id, status: "succeeded" }),
  ).rejects.toThrow("BACKUP_NOT_ACTIVE");
  const raw = JSON.stringify(
    await f.sql.query("SELECT * FROM ephor_backup_destination"),
  );
  const listed = JSON.stringify(await f.backups.list());
  for (const value of [
    storage.secretKey,
    storage.accessKey,
    check?.password ?? "never",
  ]) {
    expect(raw).not.toContain(value);
    expect(listed).not.toContain(value);
  }
  await f.backups.report(f.source.id, {
    id: check?.id,
    status: "failed",
    error: "secret from provider",
  });
  expect((await f.backups.list()).destinations[0]?.status).toBe("failed");
  expect(JSON.stringify(await f.backups.list())).not.toContain(
    "secret from provider",
  );
});
test("scheduled backup is idempotent, catches up once and serializes against deployments", async () => {
  const f = await configured();
  const due = Date.now() - 86400000;
  await f.sql.query("UPDATE ephor_backup_plan SET next_run=$1 WHERE id=$2", [
    due,
    f.plan.id,
  ]);
  await Promise.all([f.backups.tick(f.source.id), f.backups.tick(f.source.id)]);
  const jobs = (await f.backups.list()).jobs.filter(
    (j) => j.action === "backup",
  );
  expect(jobs).toHaveLength(1);
  // Simulate a crash between inserting the scheduled job and advancing the schedule.
  await f.sql.query("UPDATE ephor_backup_plan SET next_run=$1 WHERE id=$2", [
    due,
    f.plan.id,
  ]);
  await f.backups.tick(f.source.id);
  expect(Number((await f.backups.plan(f.plan.id)).next_run)).toBeGreaterThan(
    Date.now(),
  );
  await expect(f.services.queue(f.service.id, "stop")).rejects.toThrow(
    "BACKUP_ALREADY_RUNNING",
  );
  const job = await f.backups.next(f.source.id, 4);
  expect(job?.job?.spec.environment.DB_PASSWORD).toBe(
    f.cfg.config.environment.DB_PASSWORD,
  );
  expect(await f.services.next(f.source.id, 4)).toBeNull();
  await expect(
    f.backups.report(f.source.id, {
      id: job?.id,
      status: "succeeded",
      snapshot: "latest",
    }),
  ).rejects.toThrow("INVALID_BACKUP_REPORT");
  await f.backups.report(f.source.id, {
    id: job?.id,
    status: "succeeded",
    snapshot: "a".repeat(64),
  });
  await f.backups.report(f.source.id, {
    id: job?.id,
    status: "succeeded",
    snapshot: "a".repeat(64),
  });
  const listed = JSON.stringify(await f.backups.list());
  expect(listed).not.toContain(job?.password ?? "never");
  expect(listed).not.toContain(f.cfg.config.environment.DB_PASSWORD ?? "never");
});
test("recipe incompatibility is reported distinctly without exposing worker errors", async () => {
  const f = await configured();
  for (const error of ["BACKUP_RECIPE_MISMATCH", "untrusted worker detail"]) {
    const backup = await f.backups.queue(f.plan.id);
    await f.backups.next(f.source.id, 4);
    await f.backups.report(f.source.id, {
      id: backup.id,
      status: "failed",
      error,
    });
    const job = (await f.backups.list()).jobs.find((j) => j.id === backup.id);
    expect(job?.error).toBe(
      error === "BACKUP_RECIPE_MISMATCH"
        ? "BACKUP_RECIPE_MISMATCH"
        : "BACKUP_STORAGE_FAILED",
    );
  }
});
test("restores create separate services using snapshot credentials, work with the source offline and enforce target architecture", async () => {
  const f = await configured();
  const backup = await f.backups.queue(f.plan.id);
  await f.backups.next(f.source.id, 4);
  await f.backups.report(f.source.id, {
    id: backup.id,
    status: "succeeded",
    snapshot: "b".repeat(64),
  });
  await f.sql.query(
    "UPDATE ephor_service_worker SET last_seen=0 WHERE machine_id=$1",
    [f.source.id],
  );
  await expect(
    f.backups.restore({
      backupId: backup.id,
      machineId: f.target.id,
      name: "Restored",
      domain: "db.example.com",
    }),
  ).rejects.toThrow("DATABASE_MUST_BE_PRIVATE");
  const restored = await f.backups.restore({
    backupId: backup.id,
    machineId: f.target.id,
    name: "Restored",
  });
  expect(restored.serviceId).not.toBe(f.service.id);
  const task = await f.backups.next(f.target.id, 4);
  expect(task?.snapshot).toBe("b".repeat(64));
  expect(task?.sourceServiceId).toBe(f.service.id);
  expect(task?.job?.spec.environment).toEqual(f.cfg.config.environment);
  expect((await f.services.get(f.service.id)).machine_id).toBe(f.source.id);
  await f.backups.report(f.target.id, { id: restored.id, status: "succeeded" });
  expect((await f.services.get(restored.serviceId)).current_deployment).toBe(
    restored.id,
  );
  await f.sql.query("UPDATE ephor_machine SET telemetry=$1 WHERE id=$2", [
    JSON.stringify({ arch: "aarch64" }),
    f.target.id,
  ]);
  await expect(
    f.backups.restore({
      backupId: backup.id,
      machineId: f.target.id,
      name: "Wrong arch",
    }),
  ).rejects.toThrow("BACKUP_ARCHITECTURE_MISMATCH");
});
test("backup endpoints require owner, exact origin and fresh passkey; recovery export is explicit and no-store", async () => {
  const f = await configured();
  expect((await f.app.request("/api/backups")).status).toBe(401);
  const kit = await f.browser.request(
    `/backups/plans/${f.plan.id}/recovery`,
    {},
  );
  expect(kit.status).toBe(200);
  expect(kit.headers.get("cache-control")).toBe("no-store");
  const data = await kit.json();
  expect(data.password).toMatch(/^[a-f0-9]{64}$/);
  expect(data.secretKey).toBe(storage.secretKey);
  expect(
    (
      await f.browser.request(
        `/backups/plans/${f.plan.id}/run`,
        {},
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  for (const path of [
    `/backups/plans/${f.plan.id}/recovery`,
    `/backups/plans/${f.plan.id}/run`,
    "/backups/plans",
    "/backups/restore",
    "/backups/destinations",
  ])
    expect((await f.browser.request(path, {})).status).toBe(403);
});
test("new worker backup endpoints accept only worker credentials and protocol 4", async () => {
  const f = await setup();
  const request = (token: string, protocol: number) =>
    f.app.request("/api/agent/services/backup-next", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ protocol }),
    });
  expect((await request(randomToken(), 4)).status).toBe(401);
  expect((await request(f.source.token, 3)).status).toBe(409);
  expect((await request(f.source.token, 4)).status).toBe(200);
});

test("schedules can be paused offline and credential rotation preserves repository identity", async () => {
  const f = await configured({ jurisdiction: "eu" });
  await f.sql.query(
    "UPDATE ephor_backup_destination SET status='failed' WHERE id=$1",
    [f.destination.id],
  );
  await f.sql.query(
    "UPDATE ephor_service_worker SET last_seen=0 WHERE machine_id=$1",
    [f.source.id],
  );
  await f.backups.configure({
    serviceId: f.service.id,
    destinationId: f.destination.id,
    frequency: "manual",
    hour: 2,
  });
  expect(Number((await f.backups.plan(f.plan.id)).next_run)).toBe(0);
  const before = await f.backups.recovery(f.plan.id);
  expect(before.repository).toContain(".eu.r2.cloudflarestorage.com");
  await f.backups.credentials(f.destination.id, {
    machineId: f.target.id,
    accessKey: "rotated-access-key",
    secretKey: "rotated-secret-key",
  });
  const after = await f.backups.recovery(f.plan.id);
  expect(after.repository).toBe(before.repository);
  expect(after.password).toBe(before.password);
  expect(after.secretKey).toBe("rotated-secret-key");
  expect((await f.backups.destination(f.destination.id)).status).toBe(
    "pending",
  );
  const check = await f.backups.next(f.target.id, 4);
  expect(check?.destination.secretKey).toBe("rotated-secret-key");
  expect(check?.destination.endpoint).toContain(".eu.r2.cloudflarestorage.com");
});

test("concurrent plan setup returns the saved repository identity", async () => {
  const f = await setup();
  const destination = await f.backups.createDestination({
    ...storage,
    machineId: f.source.id,
  });
  const check = await f.backups.next(f.source.id, 4);
  await f.backups.report(f.source.id, { id: check?.id, status: "succeeded" });
  const body = {
    serviceId: f.service.id,
    destinationId: destination.id,
    frequency: "daily",
    hour: 2,
  };
  const results = await Promise.all([
    f.backups.configure(body),
    f.backups.configure(body),
  ]);
  expect(results[0]?.id).toBe(results[1]?.id);
  expect((await f.backups.list()).plans).toHaveLength(1);
  const kit = await f.backups.recovery(results[0]?.id);
  expect(kit.password).toMatch(/^[a-f0-9]{64}$/);
  expect(kit.repository).toContain(results[0]?.id ?? "missing");
});

test("plan health uses complete backup history and keeps failures until a successful retry", async () => {
  const f = await configured();
  const first = (await f.backups.list()).plans[0];
  expect(first?.created_at).toBeNumber();
  expect(first?.last_success).toBeNull();
  expect(first?.last_status).toBeNull();
  const now = Date.now();
  await f.sql.query(
    "INSERT INTO ephor_backup_job (id,machine_id,service_id,plan_id,destination_id,action,payload,status,snapshot_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'backup','{}','succeeded',$6,$7,$7)",
    [
      crypto.randomUUID(),
      f.source.id,
      f.service.id,
      f.plan.id,
      f.destination.id,
      "a".repeat(64),
      now - 10000,
    ],
  );
  // More recent storage checks push the successful backup out of the UI's
  // 500-job history, but must not erase the plan's verified recovery point.
  for (let i = 0; i < 501; i++)
    await f.sql.query(
      "INSERT INTO ephor_backup_job (id,machine_id,destination_id,action,payload,status,created_at,updated_at) VALUES ($1,$2,$3,'check','{}','succeeded',$4,$4)",
      [crypto.randomUUID(), f.source.id, f.destination.id, now + i],
    );
  let listed = await f.backups.list();
  expect(listed.jobs.some((job) => job.action === "backup")).toBe(false);
  expect(listed.plans[0]?.last_success).toBe(now - 10000);
  expect(listed.plans[0]?.last_status).toBe("succeeded");
  const retry = crypto.randomUUID();
  await f.sql.query(
    "INSERT INTO ephor_backup_job (id,machine_id,service_id,plan_id,destination_id,action,payload,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'backup','{}','failed',$6,$6)",
    [retry, f.source.id, f.service.id, f.plan.id, f.destination.id, now + 1000],
  );
  listed = await f.backups.list();
  expect(listed.plans[0]?.last_status).toBe("failed");
  expect(listed.plans[0]?.last_success).toBe(now - 10000);
  await f.sql.query(
    "UPDATE ephor_backup_job SET status='succeeded',snapshot_id=$1,updated_at=$2 WHERE id=$3",
    ["b".repeat(64), now + 2000, retry],
  );
  listed = await f.backups.list();
  expect(listed.plans[0]?.last_status).toBe("succeeded");
  expect(listed.plans[0]?.last_success).toBe(now + 2000);
});
