import type { AuthEnvironment } from "../auth/config";
import { retireSecurityAlerts } from "../notifications/security-legacy";
import { Notifications } from "../notifications/store";
import { securityDigest } from "./digest";
import { Security } from "./store";

export async function maintainSecurity(
  env: Pick<AuthEnvironment, "sql" | "secret" | "origin">,
  now = Date.now(),
) {
  const sql = env.sql;
  const [settings] = await sql.query(
    "UPDATE ephor_security_settings SET maintenance_at=$1 WHERE id=1 AND maintenance_at<$2 RETURNING retention_days",
    [now, now - 60000],
  );
  if (!settings) return;
  const notifications = new Notifications(
      sql,
      env.secret,
      env.origin,
      fetch,
      () => now,
    ),
    security = new Security(sql);
  const expired = await sql.query(
    "UPDATE ephor_security_finding SET status='open',accepted_until=NULL WHERE id IN (SELECT id FROM ephor_security_finding WHERE status='accepted' AND accepted_until<=$1 LIMIT 4) RETURNING id,machine_id,service_id",
    [now],
  );
  for (const f of expired)
    await security.event(
      crypto.randomUUID(),
      String(f.machine_id),
      f.service_id as string | null,
      String(f.id),
      "finding.status",
      "Ephor",
      "Risk acceptance expired",
      "open",
      "",
      now,
    );
  await retireSecurityAlerts(sql, now);
  await securityDigest(sql, notifications, now);
  const agents = await sql.query(
    `SELECT a.machine_id,a.last_seen,m.name FROM ephor_security_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.enabled=1 AND m.state='active' AND a.last_seen IS NOT NULL AND a.last_seen<$1 AND NOT EXISTS(SELECT 1 FROM ephor_notification n WHERE n.event_key='security-coverage:' || a.machine_id || ':' || CAST(a.last_seen AS TEXT) || ':' || $2) ORDER BY a.last_seen LIMIT 2`,
    [now - 30 * 60000, String(Math.floor(now / 86400000))],
  );
  for (const a of agents)
    await notifications.emit({
      key: `security-coverage:${a.machine_id}:${a.last_seen}:${Math.floor(now / 86400000)}`,
      type: "security_coverage_lost",
      title: `Security monitoring unavailable: ${String(a.name).slice(0, 80)}`,
      body: "The security helper has not reported for 30 minutes. Findings may be out of date.",
      href: `/security?machine=${a.machine_id}`,
      severity: "warning",
    });
  const cutoff = now - Number(settings.retention_days) * 86400000;
  await sql.query("DELETE FROM ephor_security_event WHERE occurred_at<$1", [
    cutoff,
  ]);
  await sql.query(
    "DELETE FROM ephor_security_scan WHERE finished_at<$1 AND status NOT IN ('queued','running') AND id NOT IN (SELECT scan_id FROM ephor_security_finding) AND EXISTS(SELECT 1 FROM ephor_security_scan n WHERE n.target=ephor_security_scan.target AND n.created_at>ephor_security_scan.created_at)",
    [cutoff],
  );
  await sql.query(
    "DELETE FROM ephor_security_finding WHERE status='resolved' AND resolved_at<$1",
    [cutoff],
  );
}
