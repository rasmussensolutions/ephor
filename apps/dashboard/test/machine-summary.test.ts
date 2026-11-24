import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Machine } from "@ephor/api/machines";
import { currentMachineMetrics } from "../src/lib/machine-metrics";
import { machineSummary } from "../src/lib/machine-summary";

const now = 100_000;
function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "one",
    name: "Production",
    status: "online",
    lastSeen: now,
    providerOverride: null,
    deploymentWorker: null,
    updaterKey: null,
    updaterSeen: null,
    createdAt: 0,
    enrolledAt: 0,
    telemetry: {
      version: 1,
      hostname: "production",
      os: "Linux",
      arch: "x86_64",
      agentVersion: "1",
      cpuCount: 2,
      cpuPercent: 100,
      memoryUsed: 80,
      memoryTotal: 100,
      uptime: 100,
      disks: [
        { mount: "/", used: 90, total: 100 },
        { mount: "/data", used: 500, total: 1000 },
      ],
    },
    ...overrides,
  };
}

test("current metrics require an online machine with a fresh report", () => {
  const current = machine();
  assert.equal(currentMachineMetrics(current, now), current.telemetry);
  assert.equal(
    currentMachineMetrics(machine({ lastSeen: now - 59_999 }), now)?.cpuPercent,
    100,
  );
  for (const status of [
    "offline",
    "pending",
    "connecting",
    "revoked",
    "expired",
  ] as const) {
    const cached = machine({ status });
    assert.equal(currentMachineMetrics(cached, now), null);
    assert.equal(cached.telemetry?.cpuPercent, 100);
  }
  assert.equal(
    currentMachineMetrics(machine({ lastSeen: now - 60_000 }), now),
    null,
  );
  assert.equal(
    currentMachineMetrics(machine({ lastSeen: now - 120_000 }), now),
    null,
  );
  assert.equal(currentMachineMetrics(machine({ lastSeen: null }), now), null);
  assert.equal(currentMachineMetrics(machine({ telemetry: null }), now), null);
});

test("zero readings are current values, not unavailable metrics", () => {
  const current = machine();
  assert.ok(current.telemetry);
  current.telemetry.cpuPercent = 0;
  current.telemetry.memoryUsed = 0;
  current.telemetry.uptime = 0;
  const disk = current.telemetry.disks[0];
  assert.ok(disk);
  disk.used = 0;
  assert.equal(currentMachineMetrics(current, now), current.telemetry);
  assert.equal(currentMachineMetrics(current, now)?.cpuPercent, 0);
});

test("weights usage by capacity and counts root disks only", () => {
  const first = machine();
  assert.ok(first.telemetry);
  const second = machine({
    name: "Secondary",
    telemetry: {
      ...first.telemetry,
      cpuCount: 6,
      cpuPercent: 0,
      memoryUsed: 20,
      memoryTotal: 300,
      disks: [{ mount: "/", used: 10, total: 300 }],
    },
  });
  const summary = machineSummary([first, second], now);
  assert.equal(summary.cpuPercent, 25);
  assert.equal(summary.memoryPercent, 25);
  assert.equal(summary.diskPercent, 25);
  assert.equal(summary.disksHigh, 1);
  assert.deepEqual(summary.busiest, { name: "Production", percent: 100 });
});

test("excludes stale resources and separates waiting and disconnected machines", () => {
  const summary = machineSummary(
    [
      machine(),
      machine({ lastSeen: now - 60_000 }),
      machine({ status: "offline" }),
      machine({ status: "pending" }),
      machine({ status: "connecting" }),
      machine({ status: "revoked" }),
      machine({ status: "expired" }),
    ],
    now,
  );
  assert.equal(summary.total, 5);
  assert.equal(summary.online, 1);
  assert.equal(summary.offline, 1);
  assert.equal(summary.stale, 1);
  assert.equal(summary.waiting, 2);
  assert.equal(summary.cores, 2);
  assert.equal(summary.memoryTotal, 100);
  assert.equal(summary.diskTotal, 100);
});

test("missing readings remain unavailable, while zero usage is valid", () => {
  const empty = machineSummary([], now);
  assert.equal(empty.total, 0);
  assert.equal(empty.cpuPercent, null);
  assert.equal(empty.memoryPercent, null);
  assert.equal(empty.diskPercent, null);
  const sample = machine().telemetry;
  assert.ok(sample);
  const summary = machineSummary(
    [
      machine({
        telemetry: {
          ...sample,
          cpuPercent: 0,
          memoryUsed: 0,
          disks: [],
        },
      }),
    ],
    now,
  );
  assert.equal(summary.cpuPercent, 0);
  assert.equal(summary.memoryPercent, 0);
  assert.equal(summary.diskPercent, null);
});
