import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createApi } from "../src";
import { randomToken } from "../src/auth/store";
import { installer, updaterInstaller } from "../src/machines/installer";
import { Releases, verifyRelease } from "../src/machines/releases";
import { MachineStore } from "../src/machines/store";
import { Updates } from "../src/machines/updates";
import { Browser, enrolled, timestamp } from "./helpers";

const keys = generateKeyPairSync("ed25519");
const publicKey = Buffer.from(
  keys.publicKey.export({ format: "jwk" }).x ?? "",
  "base64url",
).toString("hex");
function signed(changes = {}) {
  const manifest = JSON.stringify({
    schema: 1,
    version: "0.2.0",
    buildId: "a".repeat(64),
    protocol: 1,
    updaterProtocol: 1,
    channel: "stable",
    expiresAt: Date.now() + 86400000,
    artifacts: {
      x86_64: {
        url: "https://example.com/0.2.0/ephord",
        sha256: "b".repeat(64),
        size: 100,
      },
    },
    ...changes,
  });
  return {
    manifest,
    signature: sign(null, Buffer.from(manifest), keys.privateKey).toString(
      "hex",
    ),
  };
}
const sample = {
  version: 1 as const,
  hostname: "vps",
  os: "Linux",
  arch: "x86_64",
  agentVersion: "0.1.0",
  cpuCount: 1,
  cpuPercent: 1,
  memoryTotal: 1024,
  memoryUsed: 128,
  uptime: 1,
  disks: [],
};
async function ready() {
  const f = await enrolled();
  const env = {
    ...f.env,
    releaseUrl: "https://example.com/release.json",
    releasePublicKey: publicKey,
  };
  const app = createApi(env);
  const browser = new Browser(app);
  browser.cookies = f.browser.cookies;
  const machines = new MachineStore(f.sql);
  const enrollment = await machines.create("VPS");
  const credential = randomToken();
  await machines.enroll(enrollment.token, credential);
  await machines.ingest(enrollment.id, sample);
  const envelope = signed();
  await f.sql.query(
    "UPDATE ephor_release SET envelope=$1, checked_at=$2, next_check=$3 WHERE id=1",
    [JSON.stringify(envelope), Date.now(), Date.now() + 900000],
  );
  const releases = new Releases(f.sql, env.releaseUrl, publicKey);
  const updates = new Updates(f.sql, releases);
  await updates.next(enrollment.id, publicKey);
  const agent = (path: string, body: unknown, token = credential) =>
    app.request(`/api/agent/updates/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  return {
    ...f,
    app,
    browser,
    machines,
    enrollment,
    credential,
    releases,
    updates,
    agent,
    envelope,
  };
}
describe("signed daemon updates", () => {
  test("verifies exact bytes, rejects tampering, wrong keys, expiry and incompatible metadata", async () => {
    expect((await verifyRelease(signed(), publicKey)).release.version).toBe(
      "0.2.0",
    );
    const tampered = signed();
    tampered.manifest += " ";
    await expect(verifyRelease(tampered, publicKey)).rejects.toThrow();
    await expect(verifyRelease(signed(), "c".repeat(64))).rejects.toThrow();
    for (const changes of [
      { expiresAt: 1 },
      { protocol: 2 },
      { updaterProtocol: 4 },
      { version: "01.2.3" },
      { artifacts: {} },
      {
        artifacts: {
          x86_64: {
            url: "http://evil.test/a",
            sha256: "a".repeat(64),
            size: 100,
          },
        },
      },
      {
        artifacts: {
          x86_64: {
            url: "https://a.test/a",
            sha256: "a".repeat(64),
            size: 32 * 1024 * 1024 + 1,
          },
        },
      },
    ])
      await expect(verifyRelease(signed(changes), publicKey)).rejects.toThrow();
  });
  test("owner request flows through durable queue, authenticated polling, progress and completion", async () => {
    const f = await ready();
    const response = await f.browser.request("/machines/updates", {
      id: f.enrollment.id,
    });
    expect(response.status).toBe(200);
    const { id } = await response.json();
    const poll = await f.agent("next", { publicKey });
    expect(poll.status).toBe(200);
    expect((await poll.json()).job).toMatchObject({ id, envelope: f.envelope });
    for (const status of [
      "downloading",
      "installing",
      "succeeded",
      "succeeded",
    ])
      expect((await f.agent("report", { id, status })).status).toBe(200);
    expect(
      (await f.agent("report", { id, status: "downloading" })).status,
    ).toBe(409);
    expect(
      (await (await f.agent("next", { publicKey })).json()).job,
    ).toBeNull();
    const list = await (await f.browser.request("/machines")).json();
    expect(list.updates[0]).toMatchObject({ id, status: "succeeded" });
    expect(JSON.stringify(list)).not.toContain(f.credential);
    expect(JSON.stringify(list)).not.toContain(f.envelope.signature);
    const audit = await f.sql.query<{ event: string }>(
      "SELECT event FROM ephor_auth_audit WHERE subject=$1",
      [f.enrollment.id],
    );
    expect(audit.map((row) => row.event)).toEqual([
      "machine.update_requested",
      "machine.update_succeeded",
    ]);
  });
  test("requires owner session, CSRF protection and a fresh passkey", async () => {
    const f = await ready();
    expect(
      (
        await new Browser(f.app).request("/machines/updates", {
          id: f.enrollment.id,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.app.request("/api/machines/updates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: f.enrollment.id }),
        })
      ).status,
    ).toBe(403);
    await f.sql.query('UPDATE session SET "createdAt"=$1', [
      timestamp(Date.now() - 360000),
    ]);
    expect(
      (await f.browser.request("/machines/updates", { id: f.enrollment.id }))
        .status,
    ).toBe(403);
    expect(
      (await f.browser.request("/agent/updates/next", { publicKey })).status,
    ).toBe(401);
  });
  test("serializes concurrent requests and isolates machines, including revocation", async () => {
    const f = await ready();
    const results = await Promise.all([
      f.browser.request("/machines/updates", { id: f.enrollment.id }),
      f.browser.request("/machines/updates", { id: f.enrollment.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const id = (await f.updates.list())[0]?.id;
    const other = await f.machines.create("Other");
    const credential = randomToken();
    await f.machines.enroll(other.token, credential);
    expect(
      (await (await f.agent("next", { publicKey }, credential)).json()).job,
    ).toBeNull();
    expect(
      (await f.agent("report", { id, status: "failed" }, credential)).status,
    ).toBe(409);
    expect((await f.agent("report", { id, status: "succeeded" })).status).toBe(
      409,
    );
    await f.machines.revoke(f.enrollment.id);
    expect((await f.agent("next", { publicKey })).status).toBe(401);
    expect((await f.agent("report", { id, status: "failed" })).status).toBe(
      401,
    );
  });
  test("rejects downgrade, unsupported architecture and missing/stale/mismatched updater", async () => {
    const f = await ready();
    for (const changed of [
      { agentVersion: "0.2.0" },
      { agentVersion: "0.3.0" },
      { arch: "s390x" },
    ]) {
      await f.machines.ingest(f.enrollment.id, { ...sample, ...changed });
      await expect(f.updates.queue(f.enrollment.id)).rejects.toThrow(
        "NO_COMPATIBLE_UPDATE",
      );
    }
    await f.machines.ingest(f.enrollment.id, sample);
    await f.updates.next(f.enrollment.id, "f".repeat(64));
    await expect(f.updates.queue(f.enrollment.id)).rejects.toThrow(
      "UPDATER_BOOTSTRAP_REQUIRED",
    );
    await f.updates.next(f.enrollment.id, publicKey);
    await f.sql.query("UPDATE ephor_machine SET updater_seen=1 WHERE id=$1", [
      f.enrollment.id,
    ]);
    await expect(f.updates.queue(f.enrollment.id)).rejects.toThrow(
      "UPDATER_BOOTSTRAP_REQUIRED",
    );
  });
  test("expiry stops dispatch, late rollback receipts reconcile without being replayed", async () => {
    const f = await ready();
    const { id } = await f.updates.queue(f.enrollment.id);
    await f.sql.query("UPDATE ephor_update SET expires_at=1 WHERE id=$1", [id]);
    expect(await f.updates.next(f.enrollment.id, publicKey)).toBeNull();
    expect((await f.updates.list())[0]?.status).toBe("expired");
    await f.updates.report(f.enrollment.id, { id, status: "rolled_back" });
    await f.updates.report(f.enrollment.id, { id, status: "rolled_back" });
    await expect(
      f.updates.report(f.enrollment.id, { id, status: "installing" }),
    ).rejects.toThrow();
    expect((await f.updates.list())[0]?.status).toBe("rolled_back");
  });
  test("bootstrap pins trust, keeps monitoring unprivileged, and generates valid shell", async () => {
    const monitoringScript = installer("https://panel.example.com", {
      securityProtocol: 1,
      x86_64: "a".repeat(64),
    });
    expect(monitoringScript).toContain(
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
    );
    expect(monitoringScript).toContain("User=ephord");
    expect(monitoringScript).toContain("CapabilityBoundingSet=\n");
    expect(() =>
      updaterInstaller(
        "https://panel.example.com",
        { x86_64: "a".repeat(64) },
        publicKey,
      ),
    ).toThrow();
    for (const script of [
      installer(
        "https://panel.example.com",
        { x86_64: "a".repeat(64), updaterProtocol: 1, securityProtocol: 1 },
        publicKey,
      ),
      updaterInstaller(
        "https://panel.example.com",
        { x86_64: "a".repeat(64), updaterProtocol: 1 },
        publicKey,
      ),
    ]) {
      expect(script).toContain(
        `configure-updater '${publicKey}' 'https://panel.example.com'`,
      );
      expect(script).toContain(
        "ExecStart=/usr/local/libexec/ephor-updater update-worker",
      );
      expect(script).toContain("sha256sum --check --status");
      expect(script).not.toContain("--insecure");
      const child = Bun.spawn(["sh", "-n"], { stdin: "pipe", stderr: "pipe" });
      child.stdin.write(script);
      child.stdin.end();
      expect(await child.exited).toBe(0);
    }
  });
});

const components = (version = "0.1.0", buildId: string | null = null) =>
  ["monitoring", "deployments", "security", "protections", "updater"].map(
    (id) => ({
      id,
      installed: id !== "protections",
      active: id !== "protections",
      version: id === "protections" ? null : version,
      buildId,
    }),
  );
async function unified() {
  const f = await ready();
  const envelope = signed({ updaterProtocol: 2 });
  await f.sql.query("UPDATE ephor_release SET envelope=$1 WHERE id=1", [
    JSON.stringify(envelope),
  ]);
  await f.updates.next(f.enrollment.id, publicKey, 2, components());
  return f;
}
test("whole-machine requests require a compatible signer release and an inventoried updater", async () => {
  const f = await ready();
  expect(
    (
      await f.browser.request("/machines/updates", {
        id: f.enrollment.id,
        wholeMachine: true,
      })
    ).status,
  ).toBe(409);
  const envelope = signed({ updaterProtocol: 2 });
  await f.sql.query("UPDATE ephor_release SET envelope=$1 WHERE id=1", [
    JSON.stringify(envelope),
  ]);
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "MAINTENANCE_SETUP_REQUIRED",
  );
  await f.updates.next(f.enrollment.id, publicKey, 2, components());
  await expect(f.updates.queue(f.enrollment.id)).rejects.toThrow(
    "MACHINE_UPDATE_CONFIRMATION_REQUIRED",
  );
  const job = await f.updates.queue(f.enrollment.id, true);
  expect(await f.updates.next(f.enrollment.id, publicKey, 1)).toBeNull();
  expect(
    await f.updates.next(f.enrollment.id, publicKey, 2, components()),
  ).toMatchObject({ id: job.id });
  const listed = (await f.machines.list())[0];
  expect(listed?.maintenance?.components).toHaveLength(5);
  expect(
    listed?.maintenance?.components.find((c) => c.id === "protections")
      ?.installed,
  ).toBe(false);
});
test("inventory is bounded, complete and cannot select executable paths", async () => {
  const f = await ready();
  for (const invalid of [
    null,
    [],
    components().slice(1),
    [...components(), components()[0]],
    components().map((c) => ({ ...c, id: "../../bin/sh" })),
    components().map((c) => ({ ...c, buildId: "\nsecret" })),
    components().map((c) => ({ ...c, version: "garbage" })),
    components().map((c) => ({ ...c, installed: false })),
  ]) {
    expect(
      (await f.agent("next", { publicKey, protocol: 2, components: invalid }))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await f.agent("next", {
        publicKey,
        protocol: 4,
        components: components(),
      })
    ).status,
  ).toBe(400);
});
test("unified update reconciles old helpers at the current monitoring version and blocks any component downgrade", async () => {
  const f = await unified();
  const inventory = components("0.2.0", "a".repeat(64));
  await f.machines.ingest(f.enrollment.id, {
    ...sample,
    agentVersion: "0.2.0",
  });
  await f.updates.next(f.enrollment.id, publicKey, 2, inventory);
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "NO_COMPATIBLE_UPDATE",
  );
  const deployment = inventory.find((c) => c.id === "deployments");
  if (!deployment) throw new Error("Missing fixture component");
  deployment.version = "0.3.0";
  await f.updates.next(f.enrollment.id, publicKey, 2, inventory);
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "NO_COMPATIBLE_UPDATE",
  );
  deployment.version = "0.1.0";
  await f.updates.next(f.enrollment.id, publicKey, 2, inventory);
  expect(await f.updates.queue(f.enrollment.id, true)).toHaveProperty("id");
});
test("maintenance refuses active scans, blocks new claims and resumes after completion", async () => {
  const f = await unified();
  const { Security } = await import("../src/security/store");
  const { hash } = await import("../src/auth/store");
  const security = new Security(f.sql);
  const ticket = await security.issue(f.enrollment.id);
  const credential = randomToken();
  await security.enroll(ticket.token, credential);
  const scan = await security.next(
    f.enrollment.id,
    await hash(credential),
    "1",
  );
  expect(scan).not.toBeNull();
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "MACHINE_BUSY",
  );
  expect((await (await f.agent("health", {})).json()).maintenanceBusy).toBe(
    true,
  );
  await f.sql.query(
    "UPDATE ephor_security_scan SET status='succeeded' WHERE machine_id=$1",
    [f.enrollment.id],
  );
  const job = await f.updates.queue(f.enrollment.id, true);
  await security.queue(f.enrollment.id, null, true);
  expect(
    await security.next(f.enrollment.id, await hash(credential), "1"),
  ).toBeNull();
  await f.updates.report(f.enrollment.id, { id: job.id, status: "failed" });
  expect(
    await security.next(f.enrollment.id, await hash(credential), "1"),
  ).not.toBeNull();
});
test("one setup command is authorized, preserves opt-in and has valid shell", async () => {
  const f = await ready();
  const { maintenanceInstaller, maintenanceCommand } = await import(
    "../src/machines/maintenance"
  );
  const bundle = {
    updaterProtocol: 3 as const,
    serviceProtocol: 6 as const,
    securityProtocol: 1 as const,
    protectionProtocol: 1 as const,
    managedUpdatesProtocol: 2 as const,
    x86_64: "a".repeat(64),
  };
  const origin = "https://panel.example.com";
  const script = maintenanceInstaller(origin, bundle, publicKey);
  expect(script).toContain("flock -n 9");
  expect(script).toContain("/usr/local/libexec");
  expect(script).toContain('if [ -n "$protection_token" ]');
  for (const source of [
    script,
    maintenanceCommand(
      origin,
      "a".repeat(64),
      "b".repeat(64),
      "",
      "c".repeat(64),
    ),
  ]) {
    const proc = Bun.spawn(["sh", "-n"], { stdin: "pipe", stderr: "pipe" });
    proc.stdin.write(source);
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  }
  const app = createApi({
    ...f.env,
    origin,
    releaseUrl: "https://example.com/release",
    releasePublicKey: publicKey,
    loadDaemonRelease: async () => bundle,
  });
  const browser = new Browser(app);
  for (const [key, value] of f.browser.cookies)
    browser.cookies.set(key.replace(/^ephor\./, "__Host-ephor."), value);
  const request = (protections = false) =>
    browser.request(
      "/machines/maintenance/setup",
      { id: f.enrollment.id, protections },
      { origin },
    );
  expect((await request()).status).toBe(200);
  expect(
    await f.sql.query(
      "SELECT * FROM ephor_protection_agent WHERE machine_id=$1",
      [f.enrollment.id],
    ),
  ).toHaveLength(0);
  const result = await request(true);
  expect(result.status).toBe(200);
  expect((await result.json()).command).toContain("/api/agent/maintenance.sh");
  expect(
    await f.sql.query(
      "SELECT * FROM ephor_protection_agent WHERE machine_id=$1",
      [f.enrollment.id],
    ),
  ).toHaveLength(1);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 360000),
  ]);
  expect((await request()).status).toBe(403);
});

test("setup lease requires the one-time grant, blocks new jobs and releases on completion", async () => {
  const f = await unified();
  const { hash } = await import("../src/auth/store");
  const { Security } = await import("../src/security/store");
  const token = randomToken();
  await f.sql.query(
    "UPDATE ephor_machine SET maintenance_token_hash=$2,maintenance_expires=$3 WHERE id=$1",
    [f.enrollment.id, await hash(token), Date.now() + 600000],
  );
  expect(
    (await f.agent("maintenance-start", { token: randomToken() })).status,
  ).toBe(409);
  expect((await f.agent("maintenance-start", { token })).status).toBe(200);
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "MACHINE_BUSY",
  );
  const security = new Security(f.sql),
    grant = await security.issue(f.enrollment.id),
    credential = randomToken();
  await security.enroll(grant.token, credential);
  expect(
    await security.next(f.enrollment.id, await hash(credential), "1"),
  ).toBeNull();
  // A different token cannot release another setup's reservation.
  await f.agent("maintenance-end", { token: randomToken() });
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "MACHINE_BUSY",
  );
  expect((await f.agent("maintenance-end", { token })).status).toBe(200);
  expect((await f.agent("maintenance-start", { token })).status).toBe(409);
  expect(
    await security.next(f.enrollment.id, await hash(credential), "1"),
  ).not.toBeNull();
});
test("maintenance command generation preserves an existing protection credential", async () => {
  const f = await ready();
  const { Protections } = await import("../src/protections/store");
  const protections = new Protections(f.sql);
  const initial = await protections.issue(f.enrollment.id, "Owner");
  const credential = randomToken();
  await protections.enroll(initial.token, credential);
  const replacement = await protections.issue(f.enrollment.id, "Owner", true);
  expect((await protections.identity(credential)).machineId).toBe(
    f.enrollment.id,
  );
  const next = randomToken();
  await protections.enroll(replacement.token, next);
  await expect(protections.identity(credential)).rejects.toThrow();
  expect((await protections.identity(next)).machineId).toBe(f.enrollment.id);
});
test("job admission serializes across tables and recovers an expired request lock", async () => {
  const f = await unified();
  const { machineClaim } = await import("../src/machines/maintenance-lock");
  let release: () => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = machineClaim(f.sql, f.enrollment.id, async () => {
    started();
    await barrier;
    return true;
  });
  await entered;
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "MACHINE_BUSY",
  );
  expect(
    await machineClaim(f.sql, f.enrollment.id, async () => true),
  ).toBeNull();
  release();
  await held;
  await f.sql.query(
    "UPDATE ephor_machine SET claim_token='stale',claim_expires=1 WHERE id=$1",
    [f.enrollment.id],
  );
  expect(await f.updates.queue(f.enrollment.id, true)).toHaveProperty("id");
});

test("an expired installation keeps work fenced until the root updater reports recovery", async () => {
  const f = await unified();
  const { Security } = await import("../src/security/store");
  const { hash } = await import("../src/auth/store");
  const security = new Security(f.sql),
    grant = await security.issue(f.enrollment.id),
    credential = randomToken();
  await security.enroll(grant.token, credential);
  const job = await f.updates.queue(f.enrollment.id, true);
  await f.updates.report(f.enrollment.id, {
    id: job.id,
    status: "downloading",
  });
  await f.updates.report(f.enrollment.id, { id: job.id, status: "installing" });
  await f.sql.query("UPDATE ephor_update SET expires_at=1 WHERE id=$1", [
    job.id,
  ]);
  // queue() itself expires old work before checking the recovery fence.
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "UPDATE_RECOVERY_REQUIRED",
  );
  expect((await f.updates.list())[0]).toMatchObject({
    status: "expired",
    install_started: 1,
  });
  expect(
    await security.next(f.enrollment.id, await hash(credential), "1"),
  ).toBeNull();
  await f.updates.report(f.enrollment.id, {
    id: job.id,
    status: "rolled_back",
  });
  expect(
    await security.next(f.enrollment.id, await hash(credential), "1"),
  ).not.toBeNull();
});

async function sharedMachine() {
  const f = await ready();
  const envelope = signed({ updaterProtocol: 3 });
  await f.sql.query("UPDATE ephor_release SET envelope=$1 WHERE id=1", [
    JSON.stringify(envelope),
  ]);
  await f.updates.next(f.enrollment.id, publicKey, 3, components());
  return f;
}
test("shared-binary releases require migrated clients and never reach older updaters", async () => {
  const f = await sharedMachine();
  await f.updates.next(f.enrollment.id, publicKey, 2, components());
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "MAINTENANCE_SETUP_REQUIRED",
  );
  await f.updates.next(f.enrollment.id, publicKey, 3, components());
  const job = await f.updates.queue(f.enrollment.id, true);
  expect(
    await f.updates.next(f.enrollment.id, publicKey, 2, components()),
  ).toBeNull();
  expect(
    await f.updates.next(f.enrollment.id, publicKey, 3, components()),
  ).toMatchObject({ id: job.id });
});
test("manual is the default; automatic queues once and never loops on failed releases", async () => {
  const f = await sharedMachine();
  await expect(f.updates.queue(f.enrollment.id, true, true)).rejects.toThrow(
    "NO_COMPATIBLE_UPDATE",
  );
  expect(
    await f.updates.next(f.enrollment.id, publicKey, 3, components()),
  ).toBeNull();
  expect(
    (
      await f.browser.request("/machines/maintenance/policy", {
        id: f.enrollment.id,
        policy: "automatic",
      })
    ).status,
  ).toBe(200);
  const job = await f.updates.next(f.enrollment.id, publicKey, 3, components());
  expect(job).not.toBeNull();
  if (!job) throw new Error("Missing automatic update");
  expect(
    (
      await f.browser.request("/machines/maintenance/policy", {
        id: f.enrollment.id,
        policy: "pinned",
      })
    ).status,
  ).toBe(409);
  await f.updates.report(f.enrollment.id, { id: job.id, status: "failed" });
  expect(
    await f.updates.next(f.enrollment.id, publicKey, 3, components()),
  ).toBeNull();
  expect(await f.updates.queue(f.enrollment.id, true)).toHaveProperty("id");
});
test("policy changes cannot race setup and automatic admission rechecks the saved policy", async () => {
  const f = await sharedMachine();
  await f.sql.query(
    "UPDATE ephor_machine SET maintenance_until=$2 WHERE id=$1",
    [f.enrollment.id, Date.now() + 60000],
  );
  expect(
    (
      await f.browser.request("/machines/maintenance/policy", {
        id: f.enrollment.id,
        policy: "automatic",
      })
    ).status,
  ).toBe(409);
  await f.sql.query(
    "UPDATE ephor_machine SET maintenance_until=0,update_policy='automatic' WHERE id=$1",
    [f.enrollment.id],
  );
  const jobs = await Promise.all([
    f.updates.next(f.enrollment.id, publicKey, 3, components()),
    f.updates.next(f.enrollment.id, publicKey, 3, components()),
  ]);
  expect(jobs.some(Boolean)).toBe(true);
  expect(
    await f.sql.query("SELECT id FROM ephor_update WHERE machine_id=$1", [
      f.enrollment.id,
    ]),
  ).toHaveLength(1);
});
test("pinning keeps the installed version and policy changes require a fresh owner passkey", async () => {
  const f = await sharedMachine();
  expect(
    (
      await f.browser.request("/machines/maintenance/policy", {
        id: f.enrollment.id,
        policy: "pinned",
      })
    ).status,
  ).toBe(200);
  await expect(f.updates.queue(f.enrollment.id, true)).rejects.toThrow(
    "VERSION_PINNED",
  );
  const m = (await f.machines.list())[0];
  expect(m?.maintenance).toMatchObject({
    policy: "pinned",
    pinnedVersion: "0.1.0",
  });
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 360000),
  ]);
  expect(
    (
      await f.browser.request("/machines/maintenance/policy", {
        id: f.enrollment.id,
        policy: "automatic",
      })
    ).status,
  ).toBe(403);
});
test("current role installers configure the shared binary and retain service privilege boundaries", async () => {
  const { serviceInstaller } = await import("../src/services/installer");
  const { securityInstaller } = await import("../src/security/installer");
  const { protectionInstaller } = await import("../src/protections/installer");
  const bundle = {
    updaterProtocol: 3 as const,
    serviceProtocol: 6 as const,
    securityProtocol: 1 as const,
    protectionProtocol: 1 as const,
    managedUpdatesProtocol: 2 as const,
    x86_64: "a".repeat(64),
  };
  for (const generate of [
    serviceInstaller,
    securityInstaller,
    protectionInstaller,
  ]) {
    const script = generate("https://panel.example.com", bundle);
    expect(script).toContain("ExecStart=/usr/local/bin/ephord");
    expect(script).toContain("layout-check");
    expect(script).not.toContain('"$tmp/ephord"');
    expect(script).toContain('if [ "$was_active" = 1 ]');
    expect(script).toContain("NoNewPrivileges=yes");
    expect(script).toContain("ProtectSystem=strict");
    const child = Bun.spawn(["sh", "-n"], { stdin: "pipe", stderr: "pipe" });
    child.stdin.write(script);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(
      generate("https://panel.example.com", { ...bundle, updaterProtocol: 2 }),
    ).toContain("Use Maintenance with a current panel bundle.");
  }
  const install = installer("https://panel.example.com", bundle, publicKey);
  expect(install).toContain("/usr/local/bin/ephord migrate-layout");
  expect(install).toContain("ExecStart=/usr/local/bin/ephord update-worker");
  expect(install).toContain("User=ephord");
});
