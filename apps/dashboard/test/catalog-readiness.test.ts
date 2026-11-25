import { expect, test } from "bun:test";
import { catalogMachineIssue } from "../src/lib/catalog-readiness";

const now = 1_000_000;
const machine = { id: "helsinki", status: "online" as const };
const worker = { machine_id: machine.id, version: "6", last_seen: now };

test("a fresh install becomes ready when its first worker heartbeat arrives", () => {
  expect(catalogMachineIssue(machine, [], now)).toBe(
    "Waiting for deployment worker",
  );
  expect(catalogMachineIssue(machine, [{ ...worker, last_seen: 0 }], now)).toBe(
    "Waiting for deployment worker",
  );
  expect(catalogMachineIssue(machine, [worker], now)).toBeNull();
});

test("a stale heartbeat is not a version problem and a refresh restores readiness", () => {
  expect(catalogMachineIssue(machine, [worker], now + 119_999)).toBeNull();
  expect(catalogMachineIssue(machine, [worker], now + 120_000)).toBe(
    "Deployment worker offline",
  );
  expect(
    catalogMachineIssue(
      machine,
      [{ ...worker, last_seen: now + 120_000 }],
      now + 120_000,
    ),
  ).toBeNull();
  expect(catalogMachineIssue(machine, [{ ...worker, version: "2" }], now)).toBe(
    "Update deployment worker",
  );
});

test("a different or disconnected machine cannot supply deployment readiness", () => {
  expect(
    catalogMachineIssue(
      machine,
      [{ ...worker, machine_id: "old-helsinki" }],
      now,
    ),
  ).toBe("Waiting for deployment worker");
  for (const status of ["revoked", "pending", "expired"] as const) {
    expect(
      catalogMachineIssue({ ...machine, status }, [worker], now),
    ).not.toBeNull();
  }
});
