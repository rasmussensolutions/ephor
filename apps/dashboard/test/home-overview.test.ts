import { expect, test } from "bun:test";
import type { Machine } from "@ephor/api/machines";
import {
  type BackupOverview,
  backupState,
  homeOverview,
} from "../src/lib/home-overview";
import type { Deployment, Service, ServiceList } from "../src/lib/services";

const now = Date.now();
function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "machine",
    name: "Production",
    status: "online",
    lastSeen: now,
    enrolledAt: now,
    createdAt: now,
    providerOverride: null,
    deploymentWorker: null,
    updaterKey: null,
    updaterSeen: null,
    telemetry: {
      version: 1,
      hostname: "production",
      os: "Linux",
      arch: "x86_64",
      agentVersion: "1",
      cpuCount: 2,
      cpuPercent: 20,
      memoryUsed: 20,
      memoryTotal: 100,
      uptime: 100,
      disks: [{ mount: "/", used: 40, total: 100 }],
    },
    ...overrides,
  };
}
function service(overrides: Partial<Service> = {}): Service {
  return {
    id: "service",
    name: "Website",
    machineId: "machine",
    domain: null,
    spec: {} as Service["spec"],
    source: { type: "image" } as Service["source"],
    autoDeploy: false,
    currentDeployment: "deployment",
    runtime: { status: "running" } as Service["runtime"],
    runtimeAt: now,
    ...overrides,
  };
}
function data(services = [service()]): ServiceList {
  return { services, deployments: [], builds: [], workers: [] };
}
function deployment(status: string, created_at: number): Deployment {
  return {
    id: String(created_at),
    service_id: "service",
    action: "deploy",
    status,
    created_at,
    updated_at: created_at,
    source_ref: null,
    digest: null,
    error: null,
  };
}
const plan: BackupOverview["plans"][number] = {
  id: "plan",
  service_id: "service",
  destination_id: "storage",
  frequency: "daily",
  created_at: now - 3 * 86_400_000,
  last_success: now,
  last_status: "succeeded",
};

test("offline machines suppress duplicate service warnings and stale metrics", () => {
  const result = homeOverview(
    [
      machine({ lastSeen: now - 60_000 }),
      machine({ id: "revoked", status: "revoked" }),
    ],
    data([service({ runtimeAt: now - 180_000 })]),
    null,
    now,
  );
  expect(result.online).toBe(0);
  expect(result.running).toBe(0);
  expect(result.machines).toHaveLength(1);
  expect(result.attention.map((i) => i.id)).toEqual(["machine:machine"]);
});

test("disk pressure on any mount sorts affected machines first", () => {
  const m = machine();
  if (!m.telemetry) throw new Error("Missing fixture telemetry");
  m.telemetry.disks.push({ mount: "/data", used: 95, total: 100 });
  const result = homeOverview(
    [machine({ id: "other", name: "A healthy machine" }), m],
    data(),
    null,
    now,
  );
  expect(result.machines[0]?.id).toBe("machine");
  expect(result.attention[0]?.detail).toContain("/data disk is 95% full");
});

test("a failed release is visible while the old service still runs; success clears it", () => {
  const services = data();
  services.deployments = [deployment("failed", now - 1000)];
  expect(
    homeOverview([machine()], services, null, now).attention[0]?.detail,
  ).toContain("deployment failed");
  services.deployments.unshift(deployment("succeeded", now));
  expect(homeOverview([machine()], services, null, now).attention).toHaveLength(
    0,
  );
});

test("newer failed builds are visible, and obsolete failures clear after deployment", () => {
  const services = data();
  services.builds = [
    {
      id: "build",
      service_id: "service",
      status: "failed",
      phase: "build",
      logs: "",
      error: null,
      created_at: now - 1000,
    },
  ];
  expect(homeOverview([machine()], services, null, now).attention).toHaveLength(
    1,
  );
  services.deployments = [deployment("succeeded", now)];
  expect(homeOverview([machine()], services, null, now).attention).toHaveLength(
    0,
  );
});

test("counts each deploying service once and excludes backup and stop operations", () => {
  const services = data([service(), service({ id: "backup" })]);
  services.deployments = [
    deployment("running", now),
    { ...deployment("running", now), service_id: "backup", action: "backup" },
  ];
  services.builds = [
    {
      id: "build",
      service_id: "service",
      status: "built",
      phase: "ready",
      logs: "",
      error: null,
      created_at: now,
    },
  ];
  expect(homeOverview([machine()], services, null, now).deploying).toBe(1);
});

test("backup freshness allows one hour of grace and excludes manual schedules", () => {
  expect(
    backupState({ ...plan, last_success: now - 25 * 3_600_000 }, now),
  ).toBe("verified");
  expect(
    backupState({ ...plan, last_success: now - 25 * 3_600_000 - 1 }, now),
  ).toBe("overdue");
  expect(
    backupState(
      { ...plan, frequency: "weekly", last_success: now - 7 * 86_400_000 },
      now,
    ),
  ).toBe("verified");
  expect(
    backupState(
      { ...plan, frequency: "manual", last_success: now - 90 * 86_400_000 },
      now,
    ),
  ).toBe("verified");
  expect(
    backupState(
      { ...plan, created_at: now, last_success: null, last_status: null },
      now,
    ),
  ).toBe("pending");
  expect(
    backupState({ ...plan, last_success: null, last_status: null }, now),
  ).toBe("overdue");
  expect(backupState({ ...plan, last_status: "failed" }, now)).toBe("failed");
});

test("backup health requires verified copies and a ready destination", () => {
  const backups: BackupOverview = {
    plans: [plan],
    destinations: [{ id: "storage", name: "Off-site", status: "failed" }],
  };
  expect(homeOverview([], data(), backups, now).verifiedBackups).toBe(0);
  expect(homeOverview([], data(), backups, now).attention[0]?.id).toBe(
    "storage:storage",
  );
  backups.destinations = [{ id: "storage", name: "Off-site", status: "ready" }];
  expect(homeOverview([], data(), backups, now).verifiedBackups).toBe(1);
});

test("missing data produces no invented counts or healthy backup plans", () => {
  const result = homeOverview([], null, null, now);
  expect(result.machines).toHaveLength(0);
  expect(result.verifiedBackups).toBe(0);
  expect(
    backupState({ ...plan, created_at: undefined as unknown as number }, now),
  ).toBe("unknown");
});

test("cancelling a later build does not resolve a failed deployment", () => {
  const services = data();
  services.deployments = [deployment("failed", now - 1000)];
  services.builds = [
    {
      id: "cancelled",
      service_id: "service",
      status: "cancelled",
      phase: "build",
      logs: "",
      error: null,
      created_at: now,
    },
  ];
  expect(
    homeOverview([machine()], services, null, now).attention[0]?.detail,
  ).toContain("deployment failed");
});
