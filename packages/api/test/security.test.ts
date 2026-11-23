import { describe, expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { Notifications } from "../src/notifications/store";
import { securityAudit } from "../src/security/audit";
import { securityInstaller } from "../src/security/installer";
import { maintainSecurity } from "../src/security/maintenance";
import { Security } from "../src/security/store";
import type { ScanResult, SecurityCheck } from "../src/security/types";
import { scanResult } from "../src/security/validation";
import { Services } from "../src/services/store";
import { Browser, enrolled, fixture, timestamp } from "./helpers";

const check: SecurityCheck = {
  key: "ssh.passwordauthentication",
  title: "SSH passwords enabled",
  status: "fail",
  category: "ssh",
  severity: "high",
  component: "",
  evidence: "passwordauthentication yes",
  remediation: "Verify key access before disabling password authentication.",
};
const image = `sha256:${"a".repeat(64)}`;

describe("Security in initial machine enrollment", () => {
  test("independent grants activate only after monitoring and retries bind to the original credential", async () => {
    const f = await fixture(),
      machines = new MachineStore(f.sql),
      security = new Security(f.sql),
      services = new Services(f.sql, f.env.secret);
    const ticket = await machines.create("Automatic Security");
    const monitor = randomToken(),
      worker = randomToken(),
      collector = randomToken();
    expect(
      new Set([ticket.token, ticket.workerToken, ticket.securityToken]).size,
    ).toBe(3);
    await expect(
      security.enroll(ticket.securityToken, collector),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    expect(
      await f.sql.query("SELECT machine_id FROM ephor_security_agent"),
    ).toHaveLength(0);
    await machines.enroll(ticket.token, monitor);
    for (const token of [ticket.token, ticket.workerToken, monitor])
      await expect(security.enroll(token, collector)).rejects.toThrow(
        "INVALID_SECURITY_ENROLLMENT",
      );
    await services.enroll(ticket.workerToken, worker);
    await expect(security.enroll(worker, collector)).rejects.toThrow(
      "INVALID_SECURITY_ENROLLMENT",
    );
    expect(await security.enroll(ticket.securityToken, collector)).toEqual({
      id: ticket.id,
    });
    expect(await security.enroll(ticket.securityToken, collector)).toEqual({
      id: ticket.id,
    });
    await expect(
      security.enroll(ticket.securityToken, randomToken()),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    await expect(machines.identity(collector)).rejects.toThrow(
      "INVALID_MACHINE_CREDENTIAL",
    );
    await expect(services.identity(collector)).rejects.toThrow(
      "INVALID_WORKER_CREDENTIAL",
    );
    await expect(
      services.enroll(ticket.securityToken, randomToken()),
    ).rejects.toThrow("INVALID_WORKER_ENROLLMENT");
    const rows = JSON.stringify(
      await f.sql.query("SELECT * FROM ephor_machine"),
    );
    for (const token of [
      ticket.token,
      ticket.workerToken,
      ticket.securityToken,
      monitor,
    ])
      expect(rows).not.toContain(token);
    expect(JSON.stringify(await machines.list())).not.toContain(
      "security_enrollment_hash",
    );
    await security.revoke(ticket.id);
    await expect(
      security.enroll(ticket.securityToken, collector),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    await expect(security.identity(collector)).rejects.toThrow(
      "INVALID_SECURITY_CREDENTIAL",
    );
    expect(await machines.identity(monitor)).toBe(ticket.id);
    expect(await services.identity(worker)).toBe(ticket.id);
  });
  test("regeneration, cancellation, expiry and machine revocation invalidate Security grants", async () => {
    const f = await fixture(),
      machines = new MachineStore(f.sql),
      security = new Security(f.sql);
    const old = await machines.create("Regenerate");
    const ticket = await machines.regenerateEnrollment(old.id);
    await machines.enroll(ticket.token, randomToken());
    await expect(
      security.enroll(old.securityToken, randomToken()),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    expect(await security.enroll(ticket.securityToken, randomToken())).toEqual({
      id: ticket.id,
    });
    const cancelled = await machines.create("Cancel");
    await machines.cancelEnrollment(cancelled.id);
    await expect(
      security.enroll(cancelled.securityToken, randomToken()),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    const expired = await machines.create("Expire");
    await machines.enroll(expired.token, randomToken());
    await f.sql.query(
      "UPDATE ephor_machine SET enrollment_expires=0 WHERE id=$1",
      [expired.id],
    );
    await expect(
      security.enroll(expired.securityToken, randomToken()),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    const revoked = await machines.create("Revoke");
    await machines.enroll(revoked.token, randomToken());
    const credential = randomToken();
    await security.enroll(revoked.securityToken, credential);
    await machines.revoke(revoked.id);
    await expect(security.identity(credential)).rejects.toThrow(
      "INVALID_SECURITY_CREDENTIAL",
    );
    await expect(
      security.enroll(revoked.securityToken, credential),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
  });
  test("explicit repair or revocation supersedes the initial Security grant, including before its first claim", async () => {
    const f = await fixture(),
      machines = new MachineStore(f.sql),
      security = new Security(f.sql);
    for (const action of ["repair", "revoke"] as const) {
      const ticket = await machines.create(action);
      await machines.enroll(ticket.token, randomToken());
      if (action === "revoke") await security.revoke(ticket.id);
      else await security.issue(ticket.id);
      await expect(
        security.enroll(ticket.securityToken, randomToken()),
      ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
      const repair = await security.issue(ticket.id);
      const credential = randomToken();
      expect(await security.enroll(repair.token, credential)).toEqual({
        id: ticket.id,
      });
      expect((await security.identity(credential)).machineId).toBe(ticket.id);
    }
  });
});
function hostResult(status: SecurityCheck["status"] = "fail"): ScanResult {
  return {
    checks: [{ ...check, status }],
    vulnerabilities: [],
    vulnerabilitiesComplete: false,
    scanner: null,
    inventory: {
      os: "Ubuntu",
      ports: [],
      firewalls: [],
      protections: [],
      containers: [],
    },
  };
}
function serviceResult(vulnerable = true, complete = true): ScanResult {
  return {
    checks: [
      {
        ...check,
        key: "scan.coverage",
        title: "Image coverage",
        category: "coverage",
        status: complete ? "pass" : "error",
      },
    ],
    vulnerabilities: vulnerable
      ? [
          {
            advisory: "CVE-2026-1234",
            package: "example",
            installedVersion: "1.0",
            fixedVersion: "2.0",
            severity: "critical",
            component: "app",
            digest: image,
            target: "package-lock.json",
          },
        ]
      : [],
    vulnerabilitiesComplete: complete,
    scanner: { version: "0.76.2", databaseUpdatedAt: Date.now() },
    inventory: {
      os: "",
      ports: [],
      firewalls: [],
      protections: [],
      containers: [
        {
          id: "b".repeat(64),
          component: "app",
          digest: image,
          user: "65532",
          privileged: false,
          readonlyRootfs: true,
          capabilities: [],
          mounts: [],
          ports: [],
          networks: [],
        },
      ],
    },
  };
}
async function setup(owner = false) {
  const f = owner ? await enrolled() : await fixture(),
    machines = new MachineStore(f.sql),
    security = new Security(f.sql);
  const ticket = await machines.create("Security test machine"),
    monitor = randomToken();
  await machines.enroll(ticket.token, monitor);
  const enrollment = await security.issue(ticket.id),
    credential = randomToken();
  await security.enroll(enrollment.token, credential);
  const identity = await security.identity(credential);
  return {
    ...f,
    browser: "browser" in f ? (f.browser as Browser) : null,
    machines,
    security,
    machineId: ticket.id,
    monitor,
    credential,
    digest: identity.digest,
    enrollment,
  };
}
function agent(
  f: Awaited<ReturnType<typeof setup>>,
  action: string,
  body: unknown,
  credential = f.credential,
) {
  return f.app.request(`/api/agent/security/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify(body),
  });
}
async function run(
  f: Awaited<ReturnType<typeof setup>>,
  result = hostResult(),
  service?: string,
) {
  const queued = await f.security.queue(f.machineId, service);
  expect(queued).not.toBeNull();
  if (!queued) throw new Error("Scan was not queued");
  // Exercise the same queue transition while leaving unrelated automatic targets for separate scheduler tests.
  await f.sql.query(
    "UPDATE ephor_security_scan SET status='running',started_at=$2,lease_until=$3 WHERE id=$1",
    [queued?.id, Date.now(), Date.now() + 1200000],
  );
  let pending = true;
  while (pending) {
    const response = await agent(f, "report", {
      id: queued.id,
      status: "completed",
      result,
    });
    expect(response.status).toBe(200);
    pending = !!(await response.json()).pending;
  }
  return queued;
}
async function service(f: Awaited<ReturnType<typeof setup>>) {
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID();
  await f.sql.query(
    "INSERT INTO ephor_service (id,machine_id,name,config,source,created_at,current_deployment) VALUES ($1,$2,'Application','{}','{}',$3,$4)",
    [id, f.machineId, Date.now(), revision],
  );
  return id;
}

describe("security collector authorization", () => {
  test("enrollment atomically binds a ticket, retries safely, and does not leak credentials", async () => {
    const f = await setup();
    expect(await f.security.enroll(f.enrollment.token, f.credential)).toEqual({
      id: f.machineId,
    });
    await expect(
      f.security.enroll(f.enrollment.token, randomToken()),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    await f.security.next(f.machineId, f.digest, "test");
    await expect(
      f.security.enroll(f.enrollment.token, randomToken()),
    ).rejects.toThrow("INVALID_SECURITY_ENROLLMENT");
    const next = await f.security.issue(f.machineId),
      replacement = randomToken();
    await f.security.enroll(next.token, replacement);
    await expect(f.security.identity(f.credential)).rejects.toThrow(
      "INVALID_SECURITY_CREDENTIAL",
    );
    expect(JSON.stringify(await f.security.overview())).not.toContain(
      replacement,
    );
    expect(
      JSON.stringify(await f.sql.query("SELECT * FROM ephor_security_agent")),
    ).not.toContain(replacement);
  });
  test("expired tickets, revoked machines, monitoring credentials, and browser cookies cannot report", async () => {
    const f = await setup();
    expect(
      (await agent(f, "next", { version: "test" }, f.monitor)).status,
    ).toBe(401);
    await f.sql.query(
      "UPDATE ephor_security_agent SET enrollment_expires=0 WHERE machine_id=$1",
      [f.machineId],
    );
    await expect(
      f.security.enroll(f.enrollment.token, f.credential),
    ).rejects.toThrow();
    const next = await f.security.next(f.machineId, f.digest, "test");
    expect(next).not.toBeNull();
    await f.machines.revoke(f.machineId);
    expect(
      (
        await agent(f, "report", {
          id: next?.id,
          status: "completed",
          result: hostResult(),
        })
      ).status,
    ).toBe(401);
    await expect(
      f.security.report(f.machineId, f.digest, {
        id: next?.id,
        status: "completed",
        result: hostResult(),
      }),
    ).rejects.toThrow("INVALID_SECURITY_CREDENTIAL");
  });
  test("a helper cannot read owner routes, report another machine's scan, or substitute for deployment credentials", async () => {
    const f = await setup(),
      other = await f.machines.create("Other");
    await f.machines.enroll(other.token, randomToken());
    const e = await f.security.issue(other.id);
    await f.security.enroll(e.token, randomToken());
    const job = await f.security.queue(other.id);
    expect(
      (
        await agent(f, "report", {
          id: job?.id,
          status: "completed",
          result: hostResult(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.app.request("/api/security/overview", {
          headers: { authorization: `Bearer ${f.credential}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.app.request("/api/agent/services/next", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${f.credential}`,
          },
          body: '{"protocol":5}',
        })
      ).status,
    ).toBe(401);
  });
  test("owner routes preserve CSRF and fresh passkey boundaries", async () => {
    const f = await setup(true);
    const browser = f.browser;
    if (!browser) throw new Error("Owner browser missing");
    expect(
      (await new Browser(f.app).request("/security/findings")).status,
    ).toBe(401);
    expect((await browser.request("/security/overview")).status).toBe(200);
    expect(
      (
        await browser.request(
          "/security/collector/revoke",
          { machineId: f.machineId },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    await f.sql.query('UPDATE session SET "createdAt"=$1', [
      timestamp(Date.now() - 360000),
    ]);
    expect(
      (await browser.request("/security/settings", { retentionDays: 7 }))
        .status,
    ).toBe(403);
    expect(
      (
        await browser.request("/security/collector/revoke", {
          machineId: f.machineId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await browser.request("/agent/security/next", { version: "test" }))
        .status,
    ).toBe(401);
  });
});
describe("scans and findings", () => {
  test("reports are idempotent; a failed or unsupported check never resolves an existing finding", async () => {
    const f = await setup(),
      first = await run(f);
    const list = await f.security.findings(new URLSearchParams());
    expect(list.items).toHaveLength(1);
    await agent(f, "report", {
      id: first.id,
      status: "completed",
      result: hostResult("pass"),
    });
    expect(
      (await f.security.findings(new URLSearchParams())).items,
    ).toHaveLength(1);
    await run(f, hostResult("error"));
    await run(f, hostResult("unsupported"));
    expect(
      (await f.security.findings(new URLSearchParams())).items,
    ).toHaveLength(1);
    await run(f, hostResult("pass"));
    expect(
      (await f.security.findings(new URLSearchParams())).items,
    ).toHaveLength(0);
    expect(
      (await f.security.findings(new URLSearchParams("status=resolved")))
        .items[0]?.resolvedAt,
    ).toBeGreaterThan(0);
    await run(f);
    expect(
      (await f.security.findings(new URLSearchParams())).items[0]?.status,
    ).toBe("open");
  });
  test("partial image scans retain CVEs; complete replacement scans resolve them", async () => {
    const f = await setup(),
      sid = await service(f);
    await run(f, serviceResult(), sid);
    const findings = await f.security.findings(
      new URLSearchParams(`service=${sid}`),
    );
    expect(findings.items[0]?.severity).toBe("critical");
    await run(f, serviceResult(false, false), sid);
    expect(
      (await f.security.findings(new URLSearchParams())).items,
    ).toHaveLength(1);
    await run(f, serviceResult(false, true), sid);
    expect(
      (await f.security.findings(new URLSearchParams())).items,
    ).toHaveLength(0);
  });
  test("a deployment changing during a scan supersedes the report without resolving findings", async () => {
    const f = await setup(),
      sid = await service(f);
    await run(f, serviceResult(), sid);
    const job = await f.security.queue(f.machineId, sid);
    await f.sql.query(
      "UPDATE ephor_security_scan SET status='running' WHERE id=$1",
      [job?.id],
    );
    await f.sql.query(
      "UPDATE ephor_service SET current_deployment=$2 WHERE id=$1",
      [sid, crypto.randomUUID()],
    );
    await f.security.report(f.machineId, f.digest, {
      id: job?.id,
      status: "completed",
      result: serviceResult(false),
    });
    expect(
      (
        await f.sql.query(
          "SELECT status FROM ephor_security_scan WHERE id=$1",
          [job?.id],
        )
      )[0]?.status,
    ).toBe("superseded");
    expect(
      (await f.security.findings(new URLSearchParams())).items,
    ).toHaveLength(1);
  });
  test("risk acceptance requires a reason, expires, and manual resolution is rejected", async () => {
    const f = await setup();
    await run(f);
    const finding = (await f.security.findings(new URLSearchParams())).items[0];
    if (!finding) throw new Error("Missing finding");
    await expect(
      f.security.updateFinding(
        finding.id,
        { status: "accepted", reason: "" },
        "Owner",
      ),
    ).rejects.toThrow();
    await expect(
      f.security.updateFinding(finding.id, { status: "resolved" }, "Owner"),
    ).rejects.toThrow();
    await f.security.updateFinding(
      finding.id,
      {
        status: "accepted",
        reason: "MFA requires this",
        acceptedUntil: Date.now() + 60000,
      },
      "Owner",
    );
    expect(
      (await f.security.findings(new URLSearchParams())).items,
    ).toHaveLength(0);
    await f.sql.query("UPDATE ephor_security_finding SET accepted_until=$1", [
      Date.now() - 1,
    ]);
    expect(
      (await f.security.findings(new URLSearchParams())).items[0]?.status,
    ).toBe("open");
    expect(
      (
        await securityAudit(f.sql, new URLSearchParams(`finding=${finding.id}`))
      ).items.some(
        (e) => e.actor === "Owner" && e.detail === "MFA requires this",
      ),
    ).toBe(true);
  });
  test("scheduler deduplicates active requests and retries timed-out collectors", async () => {
    const f = await setup();
    const first = await f.security.queue(f.machineId),
      second = await f.security.queue(f.machineId);
    expect(second?.id).toBe(first?.id);
    const job = await f.security.next(f.machineId, f.digest, "test");
    expect(job?.id).toBe(first?.id);
    expect(await f.security.next(f.machineId, f.digest, "test")).toBeNull();
    await f.sql.query(
      "UPDATE ephor_security_scan SET lease_until=0,created_at=$1",
      [Date.now() - 3600000],
    );
    const retry = await f.security.next(f.machineId, f.digest, "test");
    expect(retry?.id).not.toBe(first?.id);
    expect(retry).not.toBeNull();
    expect(
      (
        await f.sql.query("SELECT error FROM ephor_security_scan WHERE id=$1", [
          first?.id,
        ])
      )[0]?.error,
    ).toBe("COLLECTOR_TIMEOUT");
  });
  test("empty, oversized, cross-image and stale-database reports cannot create false coverage", async () => {
    const f = await setup(),
      sid = await service(f),
      job = await f.security.queue(f.machineId, sid);
    await f.sql.query(
      "UPDATE ephor_security_scan SET status='running' WHERE id=$1",
      [job?.id],
    );
    const result = serviceResult();
    if (!result.vulnerabilities[0]) throw new Error("Missing vulnerability");
    result.vulnerabilities[0].digest = `sha256:${"b".repeat(64)}`;
    expect(
      (await agent(f, "report", { id: job?.id, status: "completed", result }))
        .status,
    ).toBe(400);
    const stale = serviceResult();
    if (!stale.scanner) throw new Error("Missing scanner");
    stale.scanner.databaseUpdatedAt = Date.now() - 72 * 3600000;
    expect(
      (
        await agent(f, "report", {
          id: job?.id,
          status: "completed",
          result: stale,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await agent(f, "report", {
          id: job?.id,
          status: "completed",
          result: { ...serviceResult(), checks: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await agent(f, "report", { payload: "x".repeat(513 * 1024) })).status,
    ).toBe(413);
    const projected = scanResult({
      ...hostResult(),
      environment: { PASSWORD: "do-not-store" },
    });
    expect(JSON.stringify(projected)).not.toContain("do-not-store");
  });
  test("overview exposes only maintenance evidence from the latest finished host scan", async () => {
    const f = await setup();
    const result = hostResult();
    const updates: SecurityCheck = {
      ...check,
      key: "maintenance.automatic-updates",
      title: "Automatic package updates",
      category: "maintenance",
      status: "pass",
      evidence: "Configured",
    };
    result.checks.push(updates);
    const finished = await run(f, result);
    await f.sql.query(
      "UPDATE ephor_security_scan SET created_at=created_at-1000 WHERE id=$1",
      [finished.id],
    );
    const queued = await f.security.queue(f.machineId);
    expect(queued).not.toBeNull();
    const overview = await f.security.overview();
    expect(overview.maintenance).toHaveLength(1);
    expect(overview.maintenance[0]?.checks).toEqual([updates]);
    expect(overview.maintenance[0]?.status).toBe("completed");
    expect(overview.scans[0]?.status).toBe("queued");
    expect(JSON.stringify(overview.maintenance)).not.toContain("inventory");
    await f.sql.query(
      "UPDATE ephor_security_scan SET status='failed',finished_at=$2 WHERE id=$1",
      [queued?.id, Date.now()],
    );
    expect((await f.security.overview()).maintenance[0]?.status).toBe("failed");
    expect((await f.security.overview()).maintenance[0]?.checks).toEqual([]);
  });
  test("service views include related host findings, but never another machine's findings", async () => {
    const f = await setup(),
      sid = await service(f);
    await run(f);
    await run(f, serviceResult(), sid);
    expect(
      (await f.security.findings(new URLSearchParams(`service=${sid}`))).items,
    ).toHaveLength(2);
    const other = crypto.randomUUID();
    expect(
      (await f.security.findings(new URLSearchParams(`service=${other}`)))
        .items,
    ).toHaveLength(0);
    const overview = await f.security.overview();
    expect(overview.scans.every((s) => s.result === null)).toBe(true);
    const scoped = await f.security.overview(
      false,
      new URLSearchParams(`service=${sid}`),
    );
    expect(
      scoped.scans.find((s) => s.serviceId === sid)?.result?.inventory
        .containers,
    ).toHaveLength(1);
  });
});
describe("audit and notification lifecycle", () => {
  test("SSH events are deduplicated, scoped, timestamp-validated, and cannot impersonate panel actions", async () => {
    const f = await setup();
    const event = {
      id: "journal-cursor-1",
      kind: "ssh.accepted",
      user: "root",
      address: "2001:db8::1",
      occurredAt: Date.now(),
    };
    expect((await agent(f, "events", { events: [event] })).status).toBe(200);
    expect((await agent(f, "events", { events: [event] })).status).toBe(200);
    const history = await securityAudit(
      f.sql,
      new URLSearchParams(`machine=${f.machineId}&kind=ssh.accepted`),
    );
    expect(history.items).toHaveLength(1);
    expect(history.items[0]?.detail).toContain("2001:db8::1");
    expect(
      (await agent(f, "events", { events: [{ ...event, kind: "panel" }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await agent(f, "events", {
          events: [{ ...event, occurredAt: Date.now() + 3600000 }],
        })
      ).status,
    ).toBe(400);
  });
  test("new findings and stale helpers notify once; old notification preferences remain compatible", async () => {
    const f = await setup();
    const notifications = new Notifications(f.sql, f.env.secret, f.env.origin);
    await notifications.settingsRow();
    await f.sql.query(
      "UPDATE ephor_notification_settings SET preferences='{}'",
    );
    await run(f);
    await f.sql.query("UPDATE ephor_security_agent SET last_seen=$1", [
      Date.now() - 3600000,
    ]);
    await maintainSecurity(f.env, Date.now() + 6 * 60000);
    await f.sql.query("UPDATE ephor_security_settings SET maintenance_at=0");
    await maintainSecurity(f.env, Date.now() + 6 * 60000);
    const rows = await f.sql.query("SELECT event_type FROM ephor_notification");
    expect(
      rows.filter((r) => r.event_type === "security_finding"),
    ).toHaveLength(1);
    expect(
      rows.filter((r) => r.event_type === "security_coverage_lost"),
    ).toHaveLength(1);
    expect(
      (await notifications.settings()).preferences.security_finding.inApp,
    ).toBe(true);
  });
  test("retention prunes old events while retaining active findings and the latest scan", async () => {
    const f = await setup();
    await run(f);
    const old = Date.now() - 100 * 86400000;
    await f.security.event(
      crypto.randomUUID(),
      f.machineId,
      null,
      null,
      "scan",
      "Scanner",
      "Old scan",
      "completed",
      "",
      old,
    );
    await f.sql.query(
      "UPDATE ephor_security_scan SET created_at=$1,finished_at=$1",
      [old],
    );
    await maintainSecurity(f.env, Date.now() + 6 * 60000);
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_security_event WHERE occurred_at<$1",
        [old + 1],
      ),
    ).toHaveLength(0);
    expect(
      await f.sql.query("SELECT id FROM ephor_security_finding"),
    ).toHaveLength(1);
    expect(
      await f.sql.query("SELECT id FROM ephor_security_scan"),
    ).toHaveLength(1);
  });
  test("large reports resume immutable batches within the D1 request budget", async () => {
    const f = await setup();
    const result = hostResult();
    result.checks = Array.from({ length: 25 }, (_, index) => ({
      ...check,
      key: `test.${index}`,
    }));
    const queued = await f.security.queue(f.machineId);
    if (!queued) throw new Error("Missing scan");
    await f.sql.query(
      "UPDATE ephor_security_scan SET status='running' WHERE id=$1",
      [queued.id],
    );
    const body = { id: queued.id, status: "completed", result };
    const original = f.sql.query.bind(f.sql);
    let queries = 0;
    f.sql.query = async (query, values) => {
      queries++;
      return original(query, values);
    };
    let response = await agent(f, "report", body);
    expect(response.status).toBe(200);
    expect((await response.json()).pending).toBe(true);
    expect(queries).toBeLessThan(50);
    expect(
      (await agent(f, "report", { ...body, result: hostResult() })).status,
    ).toBe(409);
    // Simulate an interrupted checkpoint after findings were persisted. Replay must not duplicate alerts.
    await original("UPDATE ephor_security_scan SET progress=0 WHERE id=$1", [
      queued.id,
    ]);
    let pending = true;
    while (pending) {
      queries = 0;
      response = await agent(f, "report", body);
      expect(response.status).toBe(200);
      pending = !!(await response.json()).pending;
      expect(queries).toBeLessThan(50);
    }
    expect(
      await original("SELECT id FROM ephor_security_finding"),
    ).toHaveLength(25);
    expect(
      await original(
        "SELECT id FROM ephor_security_event WHERE kind='finding.new'",
      ),
    ).toHaveLength(25);
    const clean = {
      ...result,
      checks: result.checks.map((c) => ({ ...c, status: "pass" as const })),
    };
    await run(f, clean);
    expect(
      await original(
        "SELECT id FROM ephor_security_finding WHERE status='resolved'",
      ),
    ).toHaveLength(25);
    expect(
      await original(
        "SELECT id FROM ephor_security_event WHERE kind='finding.resolved'",
      ),
    ).toHaveLength(25);
  });
  test("SSH uploads are bounded and security notifications consolidate the backlog", async () => {
    const f = await setup();
    const events = Array.from({ length: 16 }, (_, index) => ({
      id: String(index),
      kind: "ssh.accepted",
      occurredAt: Date.now(),
      user: "deploy",
      address: "127.0.0.1",
    }));
    expect((await agent(f, "events", { events })).status).toBe(200);
    expect(
      (await agent(f, "events", { events: [...events, events[0]] })).status,
    ).toBe(400);
    const result = hostResult();
    result.checks = Array.from({ length: 9 }, (_, index) => ({
      ...check,
      key: `notification.${index}`,
    }));
    await run(f, result);
    for (let i = 0; i < 4; i++) {
      await f.sql.query("UPDATE ephor_security_settings SET maintenance_at=0");
      await maintainSecurity(f.env, Date.now() + 6 * 60000);
    }
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_notification WHERE event_type='security_finding'",
      ),
    ).toHaveLength(1);
  });
  test("security installer refuses old artifacts and its shell syntax is valid", async () => {
    expect(() =>
      securityInstaller("https://example.com", { x86_64: "a".repeat(64) }),
    ).toThrow("SECURITY_BUILD_REQUIRED");
    const script = securityInstaller("https://example.com", {
      x86_64: "a".repeat(64),
      securityProtocol: 1,
    });
    expect(script).toContain(
      "CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_NET_ADMIN CAP_SYS_PTRACE",
    );
    expect(script).toContain("sha256sum --check --status");
    expect(script).not.toContain("--insecure");
    const child = Bun.spawn(["sh", "-n"], { stdin: "pipe", stderr: "pipe" });
    child.stdin.write(script);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  });
});

describe("grouped security actions and digests", () => {
  test("groups every finding beyond the raw page limit, preserves fix and layer evidence, and scopes drill-down", async () => {
    const f = await setup(true),
      sid = await service(f);
    const result = serviceResult();
    const base = result.vulnerabilities[0];
    if (!base || !f.browser) throw new Error("Missing fixture");
    result.vulnerabilities = Array.from({ length: 230 }, (_, i) => ({
      ...base,
      advisory: `CVE-2026-${10000 + Math.floor(i / 2)}`,
      package: `package-${i}`,
      fixedVersion: i % 2 ? "" : "2.0",
      target: i < 200 ? `${image} (debian 13)` : "Node.js",
    }));
    await run(f, result, sid);
    const response = await f.browser.request(
      `/security/actions?service=${sid}&workload=active`,
    );
    expect(response.status).toBe(200);
    const grouped = await response.json();
    expect(grouped.items).toHaveLength(1);
    const item = grouped.items[0];
    expect(item.count).toBe(230);
    expect(item.advisoryCount).toBe(115);
    expect(item.layers).toEqual({ os: 200, language: 30, other: 0 });
    expect(item.fixesAvailable).toBe(115);
    expect(item.noFixReported).toBe(115);
    expect(item.counts.critical).toBe(230);
    expect(item.imageCount).toBe(1);
    await run(f);
    const detail = await f.security.findings(
      new URLSearchParams({ resource: `service:${sid}` }),
    );
    expect(detail.items).toHaveLength(100);
    expect(detail.items.every((i) => i.serviceId === sid)).toBe(true);
    expect(detail.nextCursor).not.toBeNull();
    const other = await service(f);
    await run(f, serviceResult(), other);
    const isolated = await f.browser.request(
      `/security/actions?resource=service:${sid}&q=package-229`,
    );
    expect((await isolated.json()).items[0].count).toBe(1);
    const anonymous = await f.app.request("/api/security/actions");
    expect(anonymous.status).toBe(401);
  });
  test("stopped resources stay available without dominating active actions or email", async () => {
    const f = await setup(true),
      sid = await service(f),
      deployment = crypto.randomUUID();
    await run(f, serviceResult(), sid);
    await f.sql.query(
      "INSERT INTO ephor_deployment (id,service_id,machine_id,action,spec,status,created_at,updated_at) VALUES ($1,$2,$3,'stop','{}','succeeded',$4,$4)",
      [deployment, sid, f.machineId, Date.now()],
    );
    await f.sql.query(
      "UPDATE ephor_service SET current_deployment=$1 WHERE id=$2",
      [deployment, sid],
    );
    if (!f.browser) throw new Error("Missing browser fixture");
    const active = await f.browser.request("/security/actions?workload=active");
    expect((await active.json()).items).toHaveLength(0);
    const stopped = await f.browser.request(
      "/security/actions?workload=stopped",
    );
    expect((await stopped.json()).items[0].stopped).toBe(true);
    expect((await f.security.overview(true)).actionCounts).toEqual({
      active: 0,
      stopped: 1,
    });
    await maintainSecurity(f.env, Date.now() + 6 * 60000);
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_notification WHERE event_type='security_finding'",
      ),
    ).toHaveLength(0);
  });
  test("summaries settle scans, coalesce large batches, retain later findings during cooldown and do not repeat unchanged scans", async () => {
    const f = await setup(),
      sid = await service(f);
    const first = serviceResult();
    const vulnerability = first.vulnerabilities[0];
    if (!vulnerability) throw new Error("Missing vulnerability fixture");
    first.vulnerabilities = Array.from({ length: 200 }, (_, i) => ({
      ...vulnerability,
      advisory: `CVE-2026-${20000 + i}`,
    }));
    await run(f, first, sid);
    const start = Date.now();
    await maintainSecurity(f.env, start);
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_notification WHERE event_type='security_finding'",
      ),
    ).toHaveLength(0);
    await maintainSecurity(f.env, start + 6 * 60000);
    const digest = await f.sql.query(
      "SELECT title,body FROM ephor_notification WHERE event_type='security_finding'",
    );
    expect(digest).toHaveLength(1);
    expect(digest[0]?.body).toContain("200 distinct");
    await run(f, first, sid);
    await maintainSecurity(f.env, start + 25 * 3600000);
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_notification WHERE event_type='security_finding'",
      ),
    ).toHaveLength(1);
    const second = await service(f);
    await run(f, serviceResult(), second);
    await f.sql.query("UPDATE ephor_security_settings SET maintenance_at=0");
    await maintainSecurity(f.env, start + 60 * 60000);
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_notification WHERE event_type='security_finding'",
      ),
    ).toHaveLength(1);
    await maintainSecurity(f.env, start + 26 * 3600000);
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_notification WHERE event_type='security_finding'",
      ),
    ).toHaveLength(2);
    await maintainSecurity(f.env, start + 51 * 3600000);
    expect(
      await f.sql.query(
        "SELECT id FROM ephor_notification WHERE event_type='security_finding'",
      ),
    ).toHaveLength(2);
  });
});

test("grouped resource pagination is complete and does not leak host findings into a service drill-down", async () => {
  const { securityActions } = await import("../src/security/actions");
  const f = await setup();
  const ids = [];
  for (let i = 0; i < 22; i++) {
    const sid = await service(f);
    ids.push(`service:${sid}`);
    await run(f, serviceResult(), sid);
  }
  const first = await securityActions(
    f.sql,
    new URLSearchParams({ workload: "active" }),
  );
  expect(first.items).toHaveLength(20);
  if (!first.nextCursor) throw new Error("Missing grouped cursor");
  const second = await securityActions(
    f.sql,
    new URLSearchParams({ workload: "active", before: first.nextCursor }),
  );
  expect(second.items).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect([...first.items, ...second.items].map((i) => i.target).sort()).toEqual(
    ids.sort(),
  );
  await expect(
    securityActions(f.sql, new URLSearchParams({ before: "invalid" })),
  ).rejects.toThrow("INVALID_SECURITY_CURSOR");
});

test("already-submitted legacy findings are not replayed in the first digest", async () => {
  const f = await setup();
  await run(f);
  const events = await f.sql.query(
    "SELECT id FROM ephor_security_event WHERE kind='finding.new'",
  );
  const n = new Notifications(f.sql, f.env.secret, f.env.origin);
  for (const event of events)
    await n.emit({
      key: `security:${event.id}`,
      type: "security_finding",
      title: "Old alert",
      body: "Already notified",
      href: "/security",
      severity: "warning",
    });
  await f.sql.query(
    "UPDATE ephor_notification SET email_status='sent' WHERE event_type='security_finding'",
  );
  await maintainSecurity(f.env, Date.now() + 6 * 60000);
  expect(
    await f.sql.query(
      "SELECT id FROM ephor_notification WHERE event_key LIKE 'security-digest:%'",
    ),
  ).toHaveLength(0);
  expect(
    await f.sql.query(
      "SELECT id FROM ephor_notification WHERE read_at IS NOT NULL",
    ),
  ).toHaveLength(events.length);
});
