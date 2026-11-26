import { expect, test } from "bun:test";
import type { MaintenanceStatus } from "@ephor/api/maintenance";
import { requestMachineUpdate } from "../src/lib/machine-update";

function actions(status: MaintenanceStatus, consent = true) {
  const calls: string[] = [];
  return {
    calls,
    preflight: async () => {
      calls.push("preflight");
      return status;
    },
    confirm: () => {
      calls.push("confirm");
      return consent;
    },
    authenticate: async () => {
      calls.push("passkey");
    },
    queue: async () => {
      calls.push("queue");
    },
  };
}
test("a busy host names the blocker without prompting for confirmation or a passkey", async () => {
  const a = actions({
    busy: true,
    blockers: [{ kind: "security scan", id: "scan", since: 123, until: null }],
  });
  await expect(requestMachineUpdate(a)).rejects.toThrow("security scan");
  expect(a.calls).toEqual(["preflight"]);
});
test("idle updates still require confirmation and a passkey before queuing", async () => {
  const a = actions({ busy: false, blockers: [] });
  expect(await requestMachineUpdate(a)).toBe(true);
  expect(a.calls).toEqual(["preflight", "confirm", "passkey", "queue"]);
  const cancelled = actions({ busy: false, blockers: [] }, false);
  expect(await requestMachineUpdate(cancelled)).toBe(false);
  expect(cancelled.calls).toEqual(["preflight", "confirm"]);
});
test("failed preflight and authentication never queue an update", async () => {
  const a = actions({ busy: false, blockers: [] });
  a.preflight = async () => {
    throw new Error("offline");
  };
  await expect(requestMachineUpdate(a)).rejects.toThrow("offline");
  expect(a.calls).toEqual([]);
  const b = actions({ busy: false, blockers: [] });
  b.authenticate = async () => {
    throw new Error("cancelled");
  };
  await expect(requestMachineUpdate(b)).rejects.toThrow("cancelled");
  expect(b.calls).toEqual(["preflight", "confirm"]);
});
test("explicit idle queuing requires confirmation and authentication and carries the wait instruction", async () => {
  const a = actions({
    busy: true,
    blockers: [{ kind: "security scan", id: "scan", since: 123, until: null }],
  });
  let wait = false;
  expect(
    await requestMachineUpdate({
      ...a,
      waitForIdle: true,
      queue: async (value) => {
        wait = value;
        a.calls.push("queue");
      },
    }),
  ).toBe(true);
  expect(wait).toBe(true);
  expect(a.calls).toEqual(["preflight", "confirm", "passkey", "queue"]);
});
