import { AuthError, type Sql } from "../auth/store";

export interface MaintenanceStatus {
  busy: boolean;
  blockers: {
    kind:
      | "deployment"
      | "build"
      | "backup"
      | "security scan"
      | "protection job"
      | "update"
      | "setup"
      | "job claim";
    id: string;
    since: number | null;
    until: number | null;
  }[];
}

// A read-only preflight. Admission still uses the shared machine claim and checks
// again after authentication; this snapshot must never authorize installation.
export async function maintenanceStatus(
  sql: Sql,
  machine: string,
): Promise<MaintenanceStatus> {
  if (!machine || machine.length > 64) throw new AuthError("INVALID_ID");
  const [host] = await sql.query(
    "SELECT maintenance_until,claim_expires FROM ephor_machine WHERE id=$1 AND state='active'",
    [machine],
  );
  if (!host) throw new AuthError("MACHINE_NOT_FOUND", 404);
  const now = Date.now();
  const rows = await sql.query(
    `SELECT 'deployment' AS kind,id,updated_at AS since,0 AS until FROM ephor_deployment WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT 'build',id,updated_at,0 FROM ephor_build WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT 'backup',id,updated_at,0 FROM ephor_backup_job WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT 'security scan',id,started_at,lease_until FROM ephor_security_scan WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT 'protection job',id,started_at,expires_at FROM ephor_protection_job WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT 'update',id,updated_at,expires_at FROM ephor_update WHERE machine_id=$1 AND ((status IN ('queued','downloading') AND expires_at>$2) OR status='installing' OR (status='expired' AND install_started=1)) LIMIT 50`,
    [machine, now],
  );
  const blockers: MaintenanceStatus["blockers"] = rows.map((row) => ({
    kind: row.kind as MaintenanceStatus["blockers"][number]["kind"],
    id: String(row.id),
    since: Number(row.since) || null,
    until: Number(row.until) || null,
  }));
  if (Number(host.maintenance_until) > now)
    blockers.push({
      kind: "setup",
      id: machine,
      since: null,
      until: Number(host.maintenance_until),
    });
  if (Number(host.claim_expires) > now)
    blockers.push({
      kind: "job claim",
      id: machine,
      since: null,
      until: Number(host.claim_expires),
    });
  return { busy: blockers.length > 0, blockers };
}
