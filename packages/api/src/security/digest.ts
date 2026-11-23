import { hash, type Sql } from "../auth/store";
import type { Notifications } from "../notifications/store";

const DAY = 86400000;
const SETTLE = 5 * 60000;

/** One installation-wide summary, never a separate email for each package/CVE. */
export async function securityDigest(
  sql: Sql,
  notifications: Notifications,
  now: number,
) {
  const [last] = await sql.query(
    "SELECT created_at FROM ephor_notification WHERE event_type='security_finding' AND event_key LIKE 'security-digest:%' ORDER BY created_at DESC LIMIT 1",
  );
  if (last && Number(last.created_at) > now - DAY) return;
  const eligible = `FROM ephor_security_event e
    JOIN ephor_security_finding f ON f.id=e.finding_id
    JOIN ephor_security_scan scan ON scan.id=f.scan_id
    JOIN ephor_machine m ON m.id=f.machine_id
    LEFT JOIN ephor_service s ON s.id=f.service_id
    LEFT JOIN ephor_deployment d ON d.id=s.current_deployment
    WHERE e.kind='finding.new' AND e.received_at<=$1
    AND scan.status IN ('completed','partial') AND scan.finished_at<=$1
    AND m.state='active' AND (d.action IS NULL OR d.action<>'stop')
    AND (f.service_id IS NULL OR s.id IS NOT NULL)
    AND f.severity IN ('critical','high') AND f.status IN ('open','acknowledged')
    AND NOT EXISTS(SELECT 1 FROM ephor_security_scan pending WHERE pending.target=f.target AND pending.status IN ('queued','running'))
    AND NOT EXISTS(SELECT 1 FROM ephor_notification_source seen WHERE seen.id='security-event:' || e.id)`;
  const rows = await sql.query(
    `SELECT e.id,f.target,f.rule,f.category,f.severity,m.name AS machine_name,s.name AS service_name ${eligible} ORDER BY e.id`,
    [now - SETTLE],
  );
  if (!rows.length) return;
  const resources = new Map<
    string,
    {
      name: string;
      advisories: Set<string>;
      critical: Set<string>;
      checks: Set<string>;
    }
  >();
  for (const row of rows) {
    const target = String(row.target);
    const group = resources.get(target) ?? {
      name: String(row.service_name ?? row.machine_name)
        .replace(/\p{Cc}/gu, " ")
        .slice(0, 80),
      advisories: new Set<string>(),
      critical: new Set<string>(),
      checks: new Set<string>(),
    };
    if (row.category === "vulnerability")
      group.advisories.add(String(row.rule));
    else group.checks.add(String(row.rule));
    if (row.severity === "critical") group.critical.add(String(row.rule));
    resources.set(target, group);
  }
  const groups = [...resources.values()];
  const lines = groups
    .slice(0, 10)
    .map(
      (g) =>
        `${g.name}: ${g.advisories.size} distinct high/critical package advisories, ${g.checks.size} configuration findings${g.critical.size ? ` (${g.critical.size} critical)` : ""}.`,
    );
  if (groups.length > 10)
    lines.push(
      `Plus ${groups.length - 10} other resources. Open Security for the complete list.`,
    );
  const key = `security-digest:${await hash(JSON.stringify(rows.map((r) => r.id)))}`;
  await notifications.emit({
    key,
    type: "security_finding",
    severity: "warning",
    title: `Security review: ${groups.length} affected resource${groups.length === 1 ? "" : "s"}`,
    body: `${lines.join("\n")}\n\nReview grouped maintenance actions in Security. Package advisory severity does not establish runtime exploitability. Security finding summaries are limited to one every 24 hours; unchanged findings are not sent again.`,
    href: "/security",
  });
  // Mark only this settled batch. Emitting first and a content-derived event key make retries safe.
  await sql.query(
    `INSERT INTO ephor_notification_source (id,processed_at) SELECT 'security-event:' || e.id,$2 ${eligible} ON CONFLICT(id) DO NOTHING`,
    [now - SETTLE, now],
  );
}
