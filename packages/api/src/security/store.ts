import { AuthError, hash, randomToken, type Sql } from "../auth/store";
import { machineClaim } from "../machines/maintenance-lock";
import { TOKEN } from "../machines/store";
import { object } from "../services/spec";
import { findingFilter, findingJoins, stoppedResource } from "./finding-filter";
import type {
  FindingList,
  SecurityFinding,
  SecurityOverview,
  SecurityScan,
} from "./types";
import { severities } from "./types";
import { id, scanResult, text } from "./validation";

const HOUR = 3600000;
type Row = Record<string, unknown>;
const time = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
export function scan(row: Row): SecurityScan {
  return {
    id: String(row.id),
    machineId: String(row.machine_id),
    serviceId: row.service_id as string | null,
    target: String(row.target),
    revision: row.revision as string | null,
    status: row.status as SecurityScan["status"],
    createdAt: Number(row.created_at),
    startedAt: time(row.started_at),
    finishedAt: time(row.finished_at),
    error: row.error as string | null,
    result: row.result ? JSON.parse(String(row.result)) : null,
  };
}
export class Security {
  constructor(readonly sql: Sql) {}

  async issue(machineId: unknown) {
    const machine = id(machineId),
      token = randomToken(),
      expires = Date.now() + 600000;
    const rows = await this.sql.query(
      `INSERT INTO ephor_security_agent (machine_id,enrollment_hash,enrollment_expires)
      SELECT id,$2,$3 FROM ephor_machine WHERE id=$1 AND state='active'
      ON CONFLICT(machine_id) DO UPDATE SET enrollment_hash=excluded.enrollment_hash,enrollment_expires=excluded.enrollment_expires,enrollment_claim_hash=NULL RETURNING machine_id`,
      [machine, await hash(token), expires],
    );
    if (!rows.length) throw new AuthError("ACTIVE_MACHINE_REQUIRED", 409);
    return { token, expiresAt: expires };
  }
  async enroll(token: string, credential: unknown) {
    if (
      !TOKEN.test(token) ||
      typeof credential !== "string" ||
      !TOKEN.test(credential) ||
      credential === token
    )
      throw new AuthError("INVALID_SECURITY_ENROLLMENT", 401);
    const digest = await hash(credential);
    const ticketHash = await hash(token);
    // Initial enrollment can provision Security only after monitoring connects. Never
    // overwrite an existing claim, explicit repair ticket, or revoked collector.
    await this.sql.query(
      `INSERT INTO ephor_security_agent (machine_id,enrollment_hash,enrollment_expires)
       SELECT id,security_enrollment_hash,enrollment_expires FROM ephor_machine
       WHERE security_enrollment_hash=$1 AND state='active' AND enrollment_expires>$2
       ON CONFLICT(machine_id) DO NOTHING`,
      [ticketHash, Date.now()],
    );
    const rows = await this.sql.query(
      `UPDATE ephor_security_agent SET credential_hash=$1,enrollment_claim_hash=$1,enabled=1
      WHERE enrollment_hash=$2 AND enrollment_expires>$3
      AND (enrollment_claim_hash IS NULL OR enrollment_claim_hash=$1)
      AND EXISTS(SELECT 1 FROM ephor_machine m WHERE m.id=machine_id AND m.state='active') RETURNING machine_id`,
      [digest, ticketHash, Date.now()],
    );
    if (!rows.length) throw new AuthError("INVALID_SECURITY_ENROLLMENT", 401);
    // Bind the one-use ticket to the first generated credential. Retries of that same claim remain valid.
    await this.sql.query(
      "UPDATE ephor_security_agent SET last_seen=NULL WHERE machine_id=$1 AND credential_hash=$2",
      [rows[0]?.machine_id, digest],
    );
    return { id: rows[0]?.machine_id };
  }
  async identity(credential: string) {
    const digest = await hash(credential);
    const [row] = await this.sql.query(
      `SELECT a.machine_id FROM ephor_security_agent a JOIN ephor_machine m ON m.id=a.machine_id
      WHERE a.credential_hash=$1 AND a.enabled=1 AND m.state='active'`,
      [digest],
    );
    if (!row) throw new AuthError("INVALID_SECURITY_CREDENTIAL", 401);
    return { machineId: String(row.machine_id), digest };
  }
  async revoke(machineId: unknown) {
    const machine = id(machineId);
    const rows = await this.sql.query(
      `INSERT INTO ephor_security_agent (machine_id,enabled)
       SELECT id,0 FROM ephor_machine WHERE id=$1 AND state='active'
       ON CONFLICT(machine_id) DO UPDATE SET enabled=0,credential_hash=NULL,enrollment_hash=NULL RETURNING machine_id`,
      [machine],
    );
    if (!rows.length) throw new AuthError("ACTIVE_MACHINE_REQUIRED", 409);
    await this.sql.query(
      "UPDATE ephor_security_scan SET status='failed',error='COLLECTOR_DISABLED',finished_at=$2 WHERE machine_id=$1 AND status IN ('queued','running')",
      [machine, Date.now()],
    );
  }
  async target(machineId: unknown, serviceId?: unknown) {
    const machine = id(machineId),
      service = serviceId ? id(serviceId) : null;
    const [agent] = await this.sql.query(
      `SELECT a.machine_id FROM ephor_security_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.machine_id=$1 AND a.enabled=1 AND a.credential_hash IS NOT NULL AND m.state='active'`,
      [machine],
    );
    if (!agent) throw new AuthError("SECURITY_COLLECTOR_REQUIRED", 409);
    let revision: string | null = null;
    if (service) {
      const [row] = await this.sql.query(
        "SELECT current_deployment FROM ephor_service WHERE id=$1 AND machine_id=$2",
        [service, machine],
      );
      if (!row) throw new AuthError("SERVICE_NOT_FOUND", 404);
      revision = row.current_deployment as string | null;
    }
    return {
      machine,
      service,
      revision,
      target: service ? `service:${service}` : `machine:${machine}`,
    };
  }
  async queue(machineId: unknown, serviceId?: unknown, force = true) {
    const t = await this.target(machineId, serviceId),
      job = crypto.randomUUID();
    await this.sql.query(
      `INSERT INTO ephor_security_scan (id,machine_id,service_id,target,revision,status,created_at,force_scan)
      VALUES ($1,$2,$3,$4,$5,'queued',$6,$7) ON CONFLICT DO NOTHING`,
      [
        job,
        t.machine,
        t.service,
        t.target,
        t.revision,
        Date.now(),
        force ? 1 : 0,
      ],
    );
    const [row] = await this.sql.query(
      "SELECT * FROM ephor_security_scan WHERE target=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      [t.target],
    );
    return row ? scan(row) : null;
  }
  async next(machineId: string, digest: string, version: unknown) {
    const now = Date.now();
    const alive = await this.sql.query(
      `UPDATE ephor_security_agent SET last_seen=$1,version=$2 WHERE machine_id=$3 AND credential_hash=$4 AND enabled=1
      AND EXISTS(SELECT 1 FROM ephor_machine WHERE id=$3 AND state='active') RETURNING machine_id`,
      [now, text(version, 80), machineId, digest],
    );
    if (!alive.length) throw new AuthError("INVALID_SECURITY_CREDENTIAL", 401);
    await this.sql.query(
      "UPDATE ephor_security_scan SET status='failed',finished_at=$2,error='COLLECTOR_TIMEOUT' WHERE machine_id=$1 AND status='running' AND lease_until<$2",
      [machineId, now],
    );
    const targets = [
      {
        service: null as string | null,
        revision: null as string | null,
        interval: HOUR,
      },
      ...(
        await this.sql.query(
          "SELECT id,current_deployment FROM ephor_service WHERE machine_id=$1 AND current_deployment IS NOT NULL",
          [machineId],
        )
      ).map((r) => ({
        service: String(r.id),
        revision: r.current_deployment as string | null,
        interval: 24 * HOUR,
      })),
    ];
    const history = await this.sql.query(
      `SELECT s.target,s.status,s.revision,s.created_at FROM ephor_security_scan s WHERE s.machine_id=$1 AND NOT EXISTS(SELECT 1 FROM ephor_security_scan n WHERE n.target=s.target AND (n.created_at>s.created_at OR (n.created_at=s.created_at AND n.id>s.id)))`,
      [machineId],
    );
    const latest = new Map(history.map((r) => [r.target, r]));
    for (const t of targets) {
      const target = t.service
        ? `service:${t.service}`
        : `machine:${machineId}`;
      const last = latest.get(target);
      const retry = last && ["failed", "partial"].includes(String(last.status));
      if (
        !last ||
        (!["queued", "running"].includes(String(last.status)) &&
          (last.revision !== t.revision ||
            now - Number(last.created_at) > (retry ? 15 * 60000 : t.interval)))
      ) {
        await this.queue(machineId, t.service, false);
        break;
      }
    }
    if (
      (
        await this.sql.query(
          "SELECT id FROM ephor_security_scan WHERE machine_id=$1 AND status='running' LIMIT 1",
          [machineId],
        )
      ).length
    )
      return null;
    const [job] =
      (await machineClaim(this.sql, machineId, async () =>
        this.sql.query(
          `UPDATE ephor_security_scan SET status='running',started_at=$2,lease_until=$3 WHERE id=(SELECT id FROM ephor_security_scan WHERE machine_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1) AND status='queued' AND NOT EXISTS (SELECT 1 FROM ephor_update WHERE machine_id=$1 AND ((status IN ('queued','downloading') AND expires_at>$2) OR status='installing' OR (status='expired' AND install_started=1))) AND NOT EXISTS (SELECT 1 FROM ephor_machine WHERE id=$1 AND maintenance_until>$2) RETURNING *`,
          [machineId, now, now + 20 * 60000],
        ),
      )) ?? [];
    return job
      ? {
          id: job.id,
          serviceId: job.service_id,
          revision: job.revision,
          force: job.force_scan === 1,
        }
      : null;
  }
  async report(machineId: string, digest: string, value: unknown) {
    const b = object(value),
      jobId = id(b.id),
      status = text(b.status, 20);
    if (!["completed", "partial", "failed"].includes(status))
      throw new AuthError("INVALID_SECURITY_REPORT");
    const [job] = await this.sql.query(
      "SELECT * FROM ephor_security_scan WHERE id=$1 AND machine_id=$2",
      [jobId, machineId],
    );
    if (!job) throw new AuthError("SCAN_NOT_FOUND", 404);
    if (job.status === "superseded") return;
    if (
      ["completed", "partial", "failed"].includes(String(job.status)) &&
      job.report_hash
    ) {
      // Recover an interrupted final audit write after the scan itself was committed.
      await this.event(
        await hash(`${jobId}:finished`),
        machineId,
        job.service_id as string | null,
        null,
        "scan",
        "Security scanner",
        job.service_id ? "Service security scan" : "Machine posture scan",
        String(job.status),
        String(job.error ?? ""),
        Number(job.finished_at),
      );
      return;
    }
    if (job.status !== "running") throw new AuthError("SCAN_NOT_RUNNING", 409);
    const now = Date.now();
    const result = status === "failed" ? null : scanResult(b.result);
    if (result) {
      if (!result.checks.length) throw new AuthError("EMPTY_SECURITY_REPORT");
      if (
        !job.service_id &&
        (result.vulnerabilities.length ||
          result.inventory.containers.length ||
          result.vulnerabilitiesComplete)
      )
        throw new AuthError("INVALID_SCAN_SCOPE");
      if (job.service_id) {
        const containers = result.inventory.containers;
        if (
          new Set(containers.map((c) => c.component)).size !== containers.length
        )
          throw new AuthError("DUPLICATE_SECURITY_COMPONENT");
        if (
          result.vulnerabilities.some(
            (v) =>
              !containers.some(
                (c) => c.component === v.component && c.digest === v.digest,
              ),
          )
        )
          throw new AuthError("INVALID_VULNERABILITY_IMAGE");
        if (
          result.vulnerabilitiesComplete &&
          (!containers.length ||
            !result.scanner?.databaseUpdatedAt ||
            now - result.scanner.databaseUpdatedAt > 48 * HOUR ||
            !result.checks.some(
              (c) => c.key === "scan.coverage" && c.status === "pass",
            ))
        )
          throw new AuthError("INVALID_SCAN_COVERAGE");
      }
    }
    const error = status === "failed" ? text(b.error, 100) : null;
    if (job.service_id) {
      const [s] = await this.sql.query(
        "SELECT current_deployment FROM ephor_service WHERE id=$1 AND machine_id=$2",
        [job.service_id, machineId],
      );
      if (!s || s.current_deployment !== job.revision) {
        await this.sql.query(
          "UPDATE ephor_security_scan SET status='superseded',finished_at=$2,error='DEPLOYMENT_CHANGED' WHERE id=$1 AND status='running'",
          [jobId, now],
        );
        return;
      }
    }
    // Recheck both revocation and job ownership in each write, including retries after interrupted reports.
    const guard = `EXISTS(SELECT 1 FROM ephor_security_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.machine_id=$1 AND a.credential_hash=$2 AND a.enabled=1 AND m.state='active') AND EXISTS(SELECT 1 FROM ephor_security_scan j WHERE j.id=$3 AND j.machine_id=$1 AND j.status='running')`;
    const base = [machineId, digest, jobId];
    if (
      !(
        await this.sql.query(
          `SELECT id FROM ephor_security_scan WHERE id=$3 AND ${guard}`,
          base,
        )
      ).length
    )
      throw new AuthError("INVALID_SECURITY_CREDENTIAL", 401);
    const reportHash = await hash(JSON.stringify({ status, result, error }));
    const bound = await this.sql.query(
      `UPDATE ephor_security_scan SET report_hash=$4,lease_until=$5 WHERE id=$3 AND (report_hash IS NULL OR report_hash=$4) AND ${guard} RETURNING id`,
      [...base, reportHash, now + 20 * 60000],
    );
    if (!bound.length) throw new AuthError("SCAN_REPORT_CHANGED", 409);
    if (result) {
      const incoming = [
        ...result.checks
          .filter((c) => c.status === "fail")
          .map((c) => ({
            rule: c.key,
            category: c.category,
            component: c.component,
            severity: c.severity,
            title: c.title,
            evidence: c.evidence,
            remediation: c.remediation,
            detail: null,
            fingerprint: [c.key, c.component],
          })),
        ...result.vulnerabilities.map((v) => ({
          rule: v.advisory,
          category: "vulnerability",
          component: v.component,
          severity: v.severity,
          title: `${v.advisory} in ${v.package}`,
          evidence: `${v.package} ${v.installedVersion}${v.fixedVersion ? `; fixed in ${v.fixedVersion}` : "; no fix reported"}`,
          remediation: v.fixedVersion
            ? `Update ${v.package} to a fixed version, rebuild the image and redeploy.`
            : "Review the advisory and monitor for a fix. Consider reducing exposure.",
          detail: v,
          fingerprint: [v.advisory, v.package, v.target, v.component, v.digest],
        })),
      ];
      const progress = Number(job.progress ?? 0);
      const batch = incoming.slice(progress, progress + 8);
      for (const f of batch) {
        const key = await hash(
          JSON.stringify([job.target, f.category, ...f.fingerprint]),
        );
        const rows = await this.sql.query(
          `INSERT INTO ephor_security_finding (id,machine_id,service_id,target,rule,category,component,severity,title,evidence,remediation,detail,first_seen,last_seen,scan_id,opened_scan)
          SELECT $4,$1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$3,$3 WHERE ${guard}
          ON CONFLICT(id) DO UPDATE SET severity=excluded.severity,title=excluded.title,evidence=excluded.evidence,remediation=excluded.remediation,detail=excluded.detail,last_seen=excluded.last_seen,scan_id=excluded.scan_id,
          opened_scan=CASE WHEN ephor_security_finding.status='resolved' THEN excluded.scan_id ELSE ephor_security_finding.opened_scan END,
          status=CASE WHEN ephor_security_finding.status='resolved' OR (ephor_security_finding.status='accepted' AND ephor_security_finding.accepted_until<=excluded.last_seen) THEN 'open' ELSE ephor_security_finding.status END,resolved_at=NULL RETURNING id,opened_scan`,
          [
            ...base,
            key,
            job.service_id,
            job.target,
            f.rule,
            f.category,
            f.component,
            f.severity,
            f.title,
            f.evidence,
            f.remediation,
            JSON.stringify(f.detail),
            now,
          ],
        );
        if (!rows.length)
          throw new AuthError("INVALID_SECURITY_CREDENTIAL", 401);
        if (rows[0]?.opened_scan === jobId)
          await this.event(
            await hash(`${jobId}:${key}:opened`),
            machineId,
            job.service_id as string | null,
            key,
            "finding.new",
            "Security scanner",
            f.title,
            "open",
            f.severity,
            now,
          );
      }
      if (batch.length) {
        await this.sql.query(
          `UPDATE ephor_security_scan SET progress=CASE WHEN progress<$4 THEN $4 ELSE progress END WHERE id=$3 AND ${guard}`,
          [...base, progress + batch.length],
        );
        return true;
      }
      const prior = await this.sql.query(
        "SELECT id,rule,category,component,status,resolved_at FROM ephor_security_finding f WHERE target=$1 AND ((status<>'resolved' AND scan_id<>$2) OR (status='resolved' AND scan_id=$2 AND NOT EXISTS(SELECT 1 FROM ephor_security_event e WHERE e.finding_id=f.id AND e.kind='finding.resolved' AND e.occurred_at=f.resolved_at)))",
        [job.target, jobId],
      );
      const verified = prior.filter((p) =>
        p.category === "vulnerability"
          ? result.vulnerabilitiesComplete
          : result.checks.some(
              (c) =>
                c.key === p.rule &&
                c.component === p.component &&
                c.status === "pass",
            ),
      );
      for (const p of verified.slice(0, 8)) {
        const changed = await this.sql.query(
          `UPDATE ephor_security_finding SET status='resolved',resolved_at=$5,scan_id=$3 WHERE id=$4 AND ${guard} RETURNING id`,
          [
            ...base,
            p.id,
            p.status === "resolved" ? Number(p.resolved_at) : now,
          ],
        );
        if (changed.length)
          await this.event(
            await hash(`${jobId}:${p.id}:resolved`),
            machineId,
            job.service_id as string | null,
            String(p.id),
            "finding.resolved",
            "Security scanner",
            "Finding verified resolved",
            "succeeded",
            "",
            p.status === "resolved" ? Number(p.resolved_at) : now,
          );
      }
      if (verified.length > 8) return true;
    }
    const effective =
      result &&
      (result.checks.some(
        (c) => c.status === "error" || c.status === "unsupported",
      ) ||
        (job.service_id && !result.vulnerabilitiesComplete))
        ? "partial"
        : status;
    const done = await this.sql.query(
      `UPDATE ephor_security_scan SET status=$4,finished_at=$5,result=$6,error=$7 WHERE id=$3 AND ${guard} RETURNING id`,
      [...base, effective, now, result ? JSON.stringify(result) : null, error],
    );
    if (!done.length) throw new AuthError("INVALID_SECURITY_CREDENTIAL", 401);
    await this.event(
      await hash(`${jobId}:finished`),
      machineId,
      job.service_id as string | null,
      null,
      "scan",
      "Security scanner",
      job.service_id ? "Service security scan" : "Machine posture scan",
      effective,
      error ?? "",
      now,
    );
  }
  async event(
    eventId: string,
    machine: string | null,
    service: string | null,
    finding: string | null,
    kind: string,
    actor: string,
    action: string,
    outcome: string,
    detail: string,
    occurred: number,
  ) {
    await this.sql.query(
      `INSERT INTO ephor_security_event (id,machine_id,service_id,finding_id,occurred_at,received_at,kind,actor,action,outcome,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
      [
        eventId,
        machine,
        service,
        finding,
        occurred,
        Date.now(),
        kind,
        actor,
        action,
        outcome,
        detail,
      ],
    );
  }
  async events(machineId: string, digest: string, value: unknown) {
    const b = object(value);
    if (!Array.isArray(b.events) || b.events.length > 16)
      throw new AuthError("INVALID_SECURITY_REPORT");
    for (const value of b.events) {
      const e = object(value),
        kind = text(e.kind, 40),
        occurred = Number(e.occurredAt);
      if (
        ![
          "ssh.accepted",
          "ssh.rejected",
          "ssh.closed",
          "collection.gap",
        ].includes(kind) ||
        !Number.isSafeInteger(occurred) ||
        occurred < 0 ||
        occurred > Date.now() + 300000
      )
        throw new AuthError("INVALID_SECURITY_REPORT");
      const address = text(e.address, 128, true),
        user = text(e.user, 80, true),
        cursor = text(e.id, 256);
      const [active] = await this.sql.query(
        "SELECT machine_id FROM ephor_security_agent a WHERE machine_id=$1 AND credential_hash=$2 AND enabled=1 AND EXISTS(SELECT 1 FROM ephor_machine m WHERE m.id=$1 AND m.state='active')",
        [machineId, digest],
      );
      if (!active) throw new AuthError("INVALID_SECURITY_CREDENTIAL", 401);
      await this.event(
        await hash(`${machineId}:${cursor}`),
        machineId,
        null,
        null,
        kind,
        user || "System",
        kind === "collection.gap"
          ? "Security log collection gap"
          : kind === "ssh.accepted"
            ? "SSH login accepted"
            : kind === "ssh.closed"
              ? "SSH session closed"
              : "SSH login rejected",
        kind === "ssh.rejected"
          ? "failed"
          : kind === "collection.gap"
            ? "unknown"
            : "succeeded",
        kind === "collection.gap"
          ? "Some journal events could not be collected. Inspect local journal retention and collector availability."
          : address
            ? `Source: ${address}`
            : "Source not recorded",
        occurred,
      );
    }
  }
  async updateFinding(findingId: string, value: unknown, actor: string) {
    const b = object(value),
      status = String(b.status);
    if (
      !/^[a-f0-9]{64}$/.test(findingId) ||
      !["open", "acknowledged", "accepted"].includes(status)
    )
      throw new AuthError("INVALID_FINDING_STATUS");
    const reason = status === "accepted" ? text(b.reason, 1000).trim() : null;
    const until =
      b.acceptedUntil === null || b.acceptedUntil === undefined
        ? null
        : Number(b.acceptedUntil);
    if (
      until !== null &&
      (!Number.isSafeInteger(until) ||
        until <= Date.now() ||
        until > Date.now() + 366 * 24 * HOUR)
    )
      throw new AuthError("INVALID_RISK_EXPIRY");
    const [row] = await this.sql.query(
      "UPDATE ephor_security_finding SET status=$2,reason=$3,accepted_until=$4 WHERE id=$1 AND status<>'resolved' RETURNING machine_id,service_id",
      [findingId, status, reason, status === "accepted" ? until : null],
    );
    if (!row) throw new AuthError("FINDING_NOT_OPEN", 409);
    await this.event(
      crypto.randomUUID(),
      row.machine_id as string,
      row.service_id as string | null,
      findingId,
      "finding.status",
      actor,
      `Finding ${status}`,
      "succeeded",
      reason ?? "",
      Date.now(),
    );
  }
  async overview(
    installerAvailable = false,
    params = new URLSearchParams(),
  ): Promise<SecurityOverview> {
    const target = params.get("service")
      ? `service:${id(params.get("service"))}`
      : params.get("machine")
        ? `machine:${id(params.get("machine"))}`
        : "";
    const [
      machines,
      services,
      scans,
      counts,
      settings,
      maintenance,
      actionCounts,
    ] = await Promise.all([
      this.sql.query(
        "SELECT m.id,m.name,m.state,a.last_seen,a.enabled,a.version FROM ephor_machine m LEFT JOIN ephor_security_agent a ON a.machine_id=m.id ORDER BY m.name",
      ),
      this.sql.query(
        "SELECT id,name,machine_id,domain,current_deployment FROM ephor_service ORDER BY name",
      ),
      this.sql.query(
        `SELECT s.id,s.machine_id,s.service_id,s.target,s.revision,s.status,s.created_at,s.started_at,s.finished_at,s.error,CASE WHEN s.target=$1 THEN s.result ELSE NULL END AS result FROM ephor_security_scan s WHERE NOT EXISTS(SELECT 1 FROM ephor_security_scan n WHERE n.target=s.target AND (n.created_at>s.created_at OR (n.created_at=s.created_at AND n.id>s.id))) ORDER BY s.created_at DESC`,
        [target],
      ),
      this.sql.query(
        "SELECT severity,COUNT(*) AS count FROM ephor_security_finding WHERE status IN ('open','acknowledged') OR (status='accepted' AND accepted_until<=$1) GROUP BY severity",
        [Date.now()],
      ),
      this.sql.query(
        "SELECT retention_days FROM ephor_security_settings WHERE id=1",
      ),
      this.sql.query(
        `SELECT s.machine_id,s.finished_at,s.status,s.result FROM ephor_security_scan s JOIN ephor_machine m ON m.id=s.machine_id WHERE s.service_id IS NULL AND m.state='active' AND s.status NOT IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM ephor_security_scan n WHERE n.target=s.target AND n.status NOT IN ('queued','running') AND (n.created_at>s.created_at OR (n.created_at=s.created_at AND n.id>s.id)))`,
      ),
      this.sql.query(
        `SELECT CASE WHEN ${stoppedResource} THEN 'stopped' ELSE 'active' END AS state,COUNT(DISTINCT f.target) AS count ${findingJoins} WHERE f.status IN ('open','acknowledged') OR (f.status='accepted' AND f.accepted_until<=$1) GROUP BY CASE WHEN ${stoppedResource} THEN 'stopped' ELSE 'active' END`,
        [Date.now()],
      ),
    ]);
    return {
      actionCounts: {
        active: Number(
          actionCounts.find((r) => r.state === "active")?.count ?? 0,
        ),
        stopped: Number(
          actionCounts.find((r) => r.state === "stopped")?.count ?? 0,
        ),
      },
      machines: machines.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        state: String(r.state),
        lastSeen: time(r.last_seen),
        enabled: r.enabled === 1,
        version: r.version as string | null,
      })),
      services: services.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        machineId: String(r.machine_id),
        domain: r.domain as string | null,
        currentDeployment: r.current_deployment as string | null,
      })),
      scans: scans.map(scan),
      counts: Object.fromEntries(
        severities.map((s) => [
          s,
          Number(counts.find((r) => r.severity === s)?.count ?? 0),
        ]),
      ) as SecurityOverview["counts"],
      maintenance: maintenance.map((r) => ({
        machineId: String(r.machine_id),
        observedAt: time(r.finished_at),
        status: String(r.status),
        checks: (r.result
          ? (JSON.parse(String(r.result)).checks ?? [])
          : []
        ).filter((c: { category: string }) => c.category === "maintenance"),
      })),
      retentionDays: Number(settings[0]?.retention_days ?? 90),
      installerAvailable,
    };
  }
  async findings(params: URLSearchParams): Promise<FindingList> {
    const { values, clauses, bind, effective } = findingFilter(params);
    const priority =
      "CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
    const before = params.get("before");
    if (before) {
      const match = /^([0-4]):([a-f0-9]{64})$/.exec(before);
      if (!match) throw new AuthError("INVALID_SECURITY_CURSOR");
      const rank = bind(Number(match[1])),
        key = bind(match[2]);
      clauses.push(
        `((${priority})>${rank} OR ((${priority})=${rank} AND f.id>${key}))`,
      );
    }
    const rows = await this.sql.query(
      `SELECT f.*,m.name AS machine_name,s.name AS service_name,(${effective}) AS effective_status ${findingJoins} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY (${priority}),f.id LIMIT 101`,
      values,
    );
    const items = rows.slice(0, 100).map(
      (r): SecurityFinding => ({
        id: String(r.id),
        machineId: String(r.machine_id),
        machineName: String(r.machine_name),
        serviceId: r.service_id as string | null,
        serviceName: r.service_name as string | null,
        rule: String(r.rule),
        category: String(r.category),
        component: String(r.component),
        severity: r.severity as SecurityFinding["severity"],
        title: String(r.title),
        evidence: String(r.evidence),
        remediation: String(r.remediation),
        detail: JSON.parse(String(r.detail)),
        status: r.effective_status as SecurityFinding["status"],
        reason: r.reason as string | null,
        acceptedUntil: time(r.accepted_until),
        firstSeen: Number(r.first_seen),
        lastSeen: Number(r.last_seen),
        resolvedAt: time(r.resolved_at),
        scanId: String(r.scan_id),
      }),
    );
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > 100 && last
          ? `${severities.indexOf(last.severity)}:${last.id}`
          : null,
    };
  }
}
