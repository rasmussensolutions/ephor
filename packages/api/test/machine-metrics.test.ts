import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import {
  MACHINE_METRIC_RETENTION,
  machineMetricsHistory,
  pruneMachineMetrics,
  recordMachineMetrics,
} from "../src/machines/metrics";
import { MachineStore, type Telemetry } from "../src/machines/store";
import { enrolled, fixture } from "./helpers";

const sample: Telemetry = {
  version: 1,
  hostname: "test-vps",
  os: "Linux",
  arch: "x86_64",
  agentVersion: "0.1.2",
  cpuCount: 2,
  cpuPercent: 20,
  memoryTotal: 4000,
  memoryUsed: 1000,
  uptime: 60,
  disks: [{ mount: "/", total: 10000, used: 2500 }],
};
async function connect(store: MachineStore, name = "Production") {
  const ticket = await store.create(name);
  const credential = randomToken();
  await store.enroll(ticket.token, credential);
  return { ...ticket, credential };
}

test("machine detail and history require the owner, isolate machines, and reject missing records and invalid ranges", async () => {
  const f = await enrolled();
  const machines = new MachineStore(f.sql);
  const a = await connect(machines);
  const b = await connect(machines, "Other");
  await machines.ingest(a.id, sample);
  for (const suffix of ["", "/metrics"]) {
    expect((await f.app.request(`/api/machines/${a.id}${suffix}`)).status).toBe(
      401,
    );
    expect(
      (
        await f.app.request(`/api/machines/${a.id}${suffix}`, {
          headers: { authorization: `Bearer ${a.credential}` },
        })
      ).status,
    ).toBe(401);
    expect((await f.browser.request(`/machines/missing${suffix}`)).status).toBe(
      404,
    );
  }
  const detail = await f.browser.request(`/machines/${a.id}`);
  expect(detail.status).toBe(200);
  const body = await detail.json();
  expect(body.machine.id).toBe(a.id);
  expect(body.machine.telemetry).toEqual(sample);
  expect(JSON.stringify(body)).not.toContain(b.id);
  expect(JSON.stringify(body)).not.toContain("credential_hash");
  expect(JSON.stringify(body)).not.toContain("enrollment_hash");
  const history = await f.browser.request(`/machines/${a.id}/metrics`);
  expect(history.status).toBe(200);
  const data = await history.json();
  expect(data.points.length).toBeLessThanOrEqual(289);
  expect(
    data.points.some((p: { cpuPercent: number | null }) => p.cpuPercent === 20),
  ).toBe(true);
  expect(
    (await machineMetricsHistory(f.sql, b.id, "24h")).points.every(
      (p) => p.cpuPercent === null,
    ),
  ).toBe(true);
  for (const range of ["__proto__", "constructor", "7d", ""]) {
    expect(
      (await f.browser.request(`/machines/${a.id}/metrics?range=${range}`))
        .status,
    ).toBe(400);
  }
});

test("machine history persists, coalesces minutes, averages longer ranges, retains gaps and nullable root storage", async () => {
  const f = await fixture();
  const machines = new MachineStore(f.sql);
  const { id } = await connect(machines);
  const now = Math.floor(Date.now() / 300000) * 300000 + 240000;
  const base = now - 600000;
  await recordMachineMetrics(f.sql, id, sample, base);
  await recordMachineMetrics(
    f.sql,
    id,
    { ...sample, cpuPercent: 40 },
    base + 15000,
  );
  // An older in-flight report cannot overwrite the latest sample in a minute.
  await recordMachineMetrics(
    f.sql,
    id,
    { ...sample, cpuPercent: 99 },
    base + 10000,
  );
  await recordMachineMetrics(
    f.sql,
    id,
    { ...sample, cpuPercent: 60, disks: [] },
    base + 60000,
  );
  await recordMachineMetrics(f.sql, id, { ...sample, cpuPercent: 80 }, now);
  const history = await machineMetricsHistory(f.sql, id, "15m", now);
  expect(history.points.find((p) => p.timestamp === base)?.cpuPercent).toBe(40);
  expect(
    history.points.find((p) => p.timestamp === base + 60000)?.diskPercent,
  ).toBeNull();
  expect(
    history.points.find((p) => p.timestamp === base + 120000)?.cpuPercent,
  ).toBeNull();
  expect(history.points.at(-1)?.cpuPercent).toBe(80);
  const long = await machineMetricsHistory(f.sql, id, "24h", now);
  const averages = long.points.filter((p) => p.cpuPercent !== null);
  expect(averages.map((p) => p.cpuPercent)).toEqual([40, 60, 80]);
  // Two samples in one 5-minute bucket are averaged, including the partial first bucket.
  await recordMachineMetrics(
    f.sql,
    id,
    { ...sample, cpuPercent: 20 },
    base + 120000,
  );
  const grouped = await machineMetricsHistory(f.sql, id, "24h", now);
  expect(
    grouped.points.find(
      (p) => p.timestamp === Math.floor((base + 60000) / 300000) * 300000,
    )?.cpuPercent,
  ).toBe(40);
  const reloaded = new MachineStore(f.sql);
  expect((await reloaded.get(id)).id).toBe(id);
  expect(
    (
      await f.sql.query(
        "SELECT * FROM ephor_machine_metric WHERE machine_id=$1",
        [id],
      )
    ).length,
  ).toBe(4);
});

test("machine history expires, excludes future reports, and cannot be appended after revocation", async () => {
  const f = await fixture();
  const machines = new MachineStore(f.sql);
  const { id } = await connect(machines);
  const now = Date.now();
  await recordMachineMetrics(
    f.sql,
    id,
    sample,
    now - MACHINE_METRIC_RETENTION - 1,
  );
  await recordMachineMetrics(f.sql, id, sample, now + 60000);
  expect(
    (await machineMetricsHistory(f.sql, id, "24h", now)).points.every(
      (p) => p.cpuPercent === null,
    ),
  ).toBe(true);
  await pruneMachineMetrics(f.sql, now);
  expect((await f.sql.query("SELECT * FROM ephor_machine_metric")).length).toBe(
    1,
  );
  await machines.revoke(id);
  await expect(machines.ingest(id, sample)).rejects.toThrow(
    "INVALID_MACHINE_CREDENTIAL",
  );
  await recordMachineMetrics(f.sql, id, sample, now);
  expect((await f.sql.query("SELECT * FROM ephor_machine_metric")).length).toBe(
    1,
  );
  await pruneMachineMetrics(f.sql, now + MACHINE_METRIC_RETENTION + 60001);
  expect(await f.sql.query("SELECT * FROM ephor_machine_metric")).toEqual([]);
});
