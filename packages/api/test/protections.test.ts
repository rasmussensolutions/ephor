import { describe, expect, test } from "bun:test";
import { hash, randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { protectionInstaller } from "../src/protections/installer";
import { Protections } from "../src/protections/store";
import type { ProtectionSnapshot } from "../src/protections/types";
import { ip, parameters, snapshot } from "../src/protections/validation";
import { Security } from "../src/security/store";
import { Browser, enrolled, fixture, timestamp } from "./helpers";

const state: ProtectionSnapshot = {
  ownership: "absent",
  supported: true,
  version: "",
  engineRunning: false,
  acquisitionReady: false,
  blocking: "off",
  confirmBefore: null,
  sshPorts: [22],
  trustedIPs: [],
  revision: "a".repeat(64),
  detail: "",
  bans: [],
};
async function setup(owner = false) {
  const f = owner ? await enrolled() : await fixture(),
    machines = new MachineStore(f.sql),
    protections = new Protections(f.sql);
  const m = await machines.create("CrowdSec host"),
    monitor = randomToken();
  await machines.enroll(m.token, monitor);
  const ticket = await protections.issue(m.id, "Owner"),
    credential = randomToken();
  await protections.enroll(ticket.token, credential);
  return {
    ...f,
    browser: "browser" in f ? (f.browser as Browser) : null,
    m,
    machines,
    protections,
    credential,
    digest: await hash(credential),
    monitor,
    ticket,
  };
}
describe("Managed protection authorization", () => {
  test("separate expiring enrollment, single claim, credential scoping and revocation", async () => {
    const f = await setup();
    expect(await f.protections.enroll(f.ticket.token, f.credential)).toEqual({
      id: f.m.id,
    });
    await expect(
      f.protections.enroll(f.ticket.token, randomToken()),
    ).rejects.toThrow("INVALID_PROTECTION_ENROLLMENT");
    await expect(f.protections.identity(f.monitor)).rejects.toThrow(
      "INVALID_PROTECTION_CREDENTIAL",
    );
    await expect(f.machines.identity(f.credential)).rejects.toThrow(
      "INVALID_MACHINE_CREDENTIAL",
    );
    await expect(new Security(f.sql).identity(f.credential)).rejects.toThrow(
      "INVALID_SECURITY_CREDENTIAL",
    );
    const saved = JSON.stringify(
      await f.sql.query("SELECT * FROM ephor_protection_agent"),
    );
    expect(saved).not.toContain(f.credential);
    expect(saved).not.toContain(f.ticket.token);
    await f.protections.revoke(f.m.id, "Owner");
    await expect(
      f.protections.enroll(f.ticket.token, f.credential),
    ).rejects.toThrow();
    await expect(f.protections.next(f.m.id, f.digest, state)).rejects.toThrow(
      "INVALID_PROTECTION_CREDENTIAL",
    );
    expect(await f.machines.identity(f.monitor)).toBe(f.m.id);
  });
  test("reviewed payload is immutable; jobs bind to machine, credential, revision and lease", async () => {
    const f = await setup();
    await f.protections.next(f.m.id, f.digest, state);
    const plan = await f.protections.plan(
      { machineId: f.m.id, action: "install", parameters: {} },
      "Owner",
    );
    expect((await f.protections.next(f.m.id, f.digest, state)).job).toBeNull();
    const approved = await f.protections.approve(plan.id, "Owner");
    expect(approved.action).toBe("install");
    const next = await f.protections.next(f.m.id, f.digest, state);
    expect(next.job?.id).toBe(plan.id);
    expect((await f.protections.next(f.m.id, f.digest, state)).job?.id).toBe(
      plan.id,
    );
    await expect(
      f.protections.report(crypto.randomUUID(), f.digest, {
        id: plan.id,
        status: "completed",
        result: "ok",
      }),
    ).rejects.toThrow();
    await f.protections.report(f.m.id, f.digest, {
      id: plan.id,
      status: "completed",
      result: "ok",
    });
    await f.protections.report(f.m.id, f.digest, {
      id: plan.id,
      status: "completed",
      result: "ok",
    });
    expect((await f.protections.next(f.m.id, f.digest, state)).job).toBeNull();
    await expect(f.protections.approve(plan.id, "Owner")).rejects.toThrow();
    const audit = await f.sql.query(
      "SELECT * FROM ephor_security_event WHERE kind='protection'",
    );
    expect(audit.some((r) => r.outcome === "approved")).toBe(true);
    expect(audit.some((r) => r.outcome === "completed")).toBe(true);
  });
  test("stale plans, expired jobs, rotated credentials and inactive machines cannot execute", async () => {
    const f = await setup();
    await f.protections.next(f.m.id, f.digest, state);
    const plan = await f.protections.plan(
      { machineId: f.m.id, action: "install" },
      "Owner",
    );
    await f.protections.next(f.m.id, f.digest, {
      ...state,
      revision: "b".repeat(64),
    });
    await expect(f.protections.approve(plan.id, "Owner")).rejects.toThrow(
      "PROTECTION_STATE_CHANGED",
    );
    const second = await f.protections.plan(
      { machineId: f.m.id, action: "install" },
      "Owner",
    );
    await f.protections.approve(second.id, "Owner");
    await f.sql.query(
      "UPDATE ephor_protection_job SET expires_at=1 WHERE id=$1",
      [second.id],
    );
    expect((await f.protections.next(f.m.id, f.digest, state)).job).toBeNull();
    await expect(
      f.protections.report(f.m.id, f.digest, {
        id: second.id,
        status: "completed",
        result: "ok",
      }),
    ).rejects.toThrow();
    await f.protections.issue(f.m.id, "Owner");
    await expect(f.protections.identity(f.credential)).rejects.toThrow();
  });
  test("only one live job; no management from offline or external hosts", async () => {
    const f = await setup();
    await expect(
      f.protections.plan({ machineId: f.m.id, action: "install" }, "Owner"),
    ).rejects.toThrow("PROTECTION_HELPER_REQUIRED");
    await f.protections.next(f.m.id, f.digest, {
      ...state,
      ownership: "external",
    });
    await expect(
      f.protections.plan({ machineId: f.m.id, action: "install" }, "Owner"),
    ).rejects.toThrow("PROTECTION_UNSUPPORTED");
    await f.protections.next(f.m.id, f.digest, state);
    const a = await f.protections.plan(
        { machineId: f.m.id, action: "install" },
        "Owner",
      ),
      b = await f.protections.plan(
        { machineId: f.m.id, action: "install" },
        "Owner",
      );
    const results = await Promise.allSettled([
      f.protections.approve(a.id, "Owner"),
      f.protections.approve(b.id, "Owner"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  test("enable needs ready detection, trusted addresses, and an unexpired confirmation", async () => {
    const f = await setup();
    await f.protections.next(f.m.id, f.digest, {
      ...state,
      ownership: "managed",
    });
    await expect(
      f.protections.plan(
        {
          machineId: f.m.id,
          action: "enable",
          parameters: { trustedIPs: ["8.8.8.8"] },
        },
        "Owner",
      ),
    ).rejects.toThrow("PROTECTION_NOT_READY");
    await f.protections.next(f.m.id, f.digest, {
      ...state,
      ownership: "managed",
      engineRunning: true,
      acquisitionReady: true,
    });
    await expect(
      f.protections.plan(
        { machineId: f.m.id, action: "enable", parameters: { trustedIPs: [] } },
        "Owner",
      ),
    ).rejects.toThrow("TRUSTED_IP_REQUIRED");
    await expect(
      f.protections.plan({ machineId: f.m.id, action: "confirm" }, "Owner"),
    ).rejects.toThrow("PROTECTION_TRIAL_EXPIRED");
  });
  test("owner endpoints require session, origin and fresh passkey; agent bearer cannot enqueue", async () => {
    const f = await setup(true),
      browser = new Browser(f.app);
    expect(
      (
        await browser.request(
          "/security/protections/plan",
          { machineId: f.m.id, action: "install" },
          { authorization: `Bearer ${f.credential}` },
        )
      ).status,
    ).toBe(401);
    // Use the real enrolled fixture's browser session.
    const owner = await enrolled();
    const response = await owner.browser.request("/security/protections");
    expect(response.status).toBe(200);
    expect(
      (
        await owner.browser.request(
          "/security/protections/revoke",
          { machineId: f.m.id },
          { origin: "https://evil.invalid" },
        )
      ).status,
    ).toBe(403);
    await owner.sql.query('UPDATE "session" SET "createdAt"=$1', [
      timestamp(Date.now() - 3600_000),
    ]);
    expect(
      (
        await owner.browser.request("/security/protections/revoke", {
          machineId: f.m.id,
        })
      ).status,
    ).toBe(403);
    const agent = await f.app.request(
      "http://localhost:3100/api/agent/protections/next",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${f.credential}`,
        },
        body: JSON.stringify({ snapshot: state }),
      },
    );
    expect(agent.status).toBe(200);
  });
});
test("strict protection values reject injection and arbitrary commands", () => {
  for (const v of [
    "1.2.3.4; reboot",
    "1.2.3.999",
    "1.2.3.4/0",
    "::1%eth0",
    "example.com",
    "01.2.3.4",
  ])
    expect(() => ip(v)).toThrow();
  expect(ip("2001:4860:4860::8888")).toBe("2001:4860:4860::8888");
  expect(() => parameters("install", { command: "reboot" })).toThrow();
  expect(() => parameters("disable", { ip: "1.1.1.1" })).toThrow();
  expect(() =>
    snapshot({
      ...state,
      bans: [{ ip: "1.1.1.1", reason: "ssh", remainingSeconds: Infinity }],
    }),
  ).toThrow();
});
test("installer keeps management and detection separate with no public listener", () => {
  const script = protectionInstaller("https://panel.example.com", {
    protectionProtocol: 1,
    managedUpdatesProtocol: 2,
    aarch64: "a".repeat(64),
  });
  expect(script).toContain("ephor-protections.service");
  expect(script).toContain("ephor-crowdsec.service");
  expect(script).toContain("sha256sum --check");
  expect(script).toContain("ExecStopPost=");
  expect(script).not.toContain("tailscale up");
  expect(script).not.toContain("ufw allow");
  expect(() =>
    protectionInstaller("https://panel.example.com", {
      aarch64: "a".repeat(64),
    }),
  ).toThrow("PROTECTION_BUILD_REQUIRED");
});

const updatePolicy = {
  days: [1, 2, 3, 4, 5, 6, 7],
  startMinute: 120,
  automaticReboot: false,
  rebootMinute: 240,
};
const updateState: ProtectionSnapshot = {
  ...state,
  updates: {
    scheduleVersion: 2,
    supported: true,
    installed: true,
    managed: false,
    enabled: false,
    healthy: false,
    busy: false,
    rebootRequired: false,
    policy: null,
    detail: "",
    lastRunAt: null,
    lastRebootRequestAt: null,
  },
};
test("update policies reject command injection, unknown settings and invalid times", () => {
  for (const patch of [
    { days: [] },
    { days: [0] },
    { days: [8] },
    { startMinute: "02:00" },
    { startMinute: 1440 },
    { windowMinutes: 0 },
    { windowMinutes: 361 },
    { rebootMinute: 1440 },
    { automaticReboot: "yes" },
    { command: "reboot" },
    { timezone: "Europe/Paris" },
  ])
    expect(() =>
      parameters("updates.install", { policy: { ...updatePolicy, ...patch } }),
    ).toThrow("INVALID_UPDATE_POLICY");
  expect(() =>
    parameters("updates.disable", { policy: updatePolicy }),
  ).toThrow();
  expect(() =>
    parameters("updates.install", { policy: updatePolicy, command: "reboot" }),
  ).toThrow();
  expect(() => parameters("install", { policy: updatePolicy })).toThrow();
  expect(
    parameters("updates.configure", {
      policy: { ...updatePolicy, days: [5, 1, 1] },
    }),
  ).toEqual({ policy: { ...updatePolicy, days: [1, 5] } });
});
test("update management requires an explicit helper capability and preserves CrowdSec ownership boundaries", async () => {
  const f = await setup();
  await f.protections.next(f.m.id, f.digest, state);
  await expect(
    f.protections.plan(
      {
        machineId: f.m.id,
        action: "updates.install",
        parameters: { policy: updatePolicy },
      },
      "Owner",
    ),
  ).rejects.toThrow("PROTECTION_HELPER_UPGRADE_REQUIRED");
  await f.protections.next(f.m.id, f.digest, {
    ...updateState,
    ownership: "external",
    supported: false,
  });
  const plan = await f.protections.plan(
    {
      machineId: f.m.id,
      action: "updates.install",
      parameters: { policy: updatePolicy },
    },
    "Owner",
  );
  expect(plan.parameters).toEqual({ policy: updatePolicy });
  expect(plan.steps.join(" ")).toContain("In-progress package transactions");
  const job = await f.protections.approve(plan.id, "Owner");
  expect(job.parameters).toEqual({ policy: updatePolicy });
  expect(
    (await f.protections.next(f.m.id, f.digest, updateState)).job?.id,
  ).toBe(job.id);
  await f.protections.report(f.m.id, f.digest, {
    id: job.id,
    status: "completed",
    result: "Policy applied",
  });
  expect(
    (
      await f.sql.query(
        "SELECT action FROM ephor_security_event WHERE action='updates.install' AND outcome='completed'",
      )
    ).length,
  ).toBe(1);
});
test("managed update conflicts and active package operations block configuration, stale revisions block approval", async () => {
  const f = await setup();
  const u = updateState.updates;
  if (!u) throw new Error("Missing update state");
  for (const updates of [
    { ...u, busy: true },
    { ...u, supported: false },
  ]) {
    await f.protections.next(f.m.id, f.digest, { ...updateState, updates });
    await expect(
      f.protections.plan(
        {
          machineId: f.m.id,
          action: "updates.install",
          parameters: { policy: updatePolicy },
        },
        "Owner",
      ),
    ).rejects.toThrow("PROTECTION_UNSUPPORTED");
  }
  await f.protections.next(f.m.id, f.digest, {
    ...updateState,
    updates: { ...u, managed: true, healthy: false },
  });
  await expect(
    f.protections.plan(
      { machineId: f.m.id, action: "updates.remove" },
      "Owner",
    ),
  ).rejects.toThrow("UPDATE_POLICY_CONFLICT");
  await f.protections.next(f.m.id, f.digest, updateState);
  const plan = await f.protections.plan(
    {
      machineId: f.m.id,
      action: "updates.install",
      parameters: { policy: updatePolicy },
    },
    "Owner",
  );
  await f.protections.next(f.m.id, f.digest, {
    ...updateState,
    revision: "b".repeat(64),
  });
  await expect(f.protections.approve(plan.id, "Owner")).rejects.toThrow(
    "PROTECTION_STATE_CHANGED",
  );
});
test("update install and reboot policy changes require owner passkey and CSRF", async () => {
  const f = await setup(true);
  if (!f.browser) throw new Error("Missing owner browser");
  await f.protections.next(f.m.id, f.digest, updateState);
  const payload = {
    machineId: f.m.id,
    action: "updates.install",
    parameters: { policy: { ...updatePolicy, automaticReboot: true } },
  };
  expect(
    (await new Browser(f.app).request("/security/protections/plan", payload))
      .status,
  ).toBe(401);
  expect(
    (
      await f.browser.request("/security/protections/plan", payload, {
        origin: "https://evil.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.browser.request("/security/protections/plan", payload)).status,
  ).toBe(200);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect(
    (await f.browser.request("/security/protections/plan", payload)).status,
  ).toBe(403);
});

test("check and reboot times are independent while legacy policies stay readable", async () => {
  const independent = {
    ...updatePolicy,
    startMinute: 1430,
    rebootMinute: 60,
    automaticReboot: true,
  };
  expect(parameters("updates.configure", { policy: independent })).toEqual({
    policy: independent,
  });
  expect(() =>
    parameters("updates.configure", {
      policy: { ...updatePolicy, windowMinutes: 180 },
    }),
  ).toThrow("INVALID_UPDATE_POLICY");
  const legacy = snapshot({
    ...updateState,
    updates: {
      ...updateState.updates,
      scheduleVersion: undefined,
      managed: true,
      healthy: true,
      policy: { ...updatePolicy, windowMinutes: 180 },
    },
  });
  expect(legacy.updates?.policy?.windowMinutes).toBe(180);
  const f = await setup();
  await f.protections.next(f.m.id, f.digest, legacy);
  await expect(
    f.protections.plan(
      {
        machineId: f.m.id,
        action: "updates.configure",
        parameters: { policy: independent },
      },
      "Owner",
    ),
  ).rejects.toThrow("PROTECTION_HELPER_UPGRADE_REQUIRED");
});
