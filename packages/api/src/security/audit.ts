import { AuthError, type Sql } from "../auth/store";
import type { SecurityEvent, SecurityEventList } from "./types";
import { id, text } from "./validation";

export async function securityAudit(
  sql: Sql,
  params: URLSearchParams,
): Promise<SecurityEventList> {
  const values: unknown[] = [],
    clauses: string[] = [],
    bind = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };
  if (params.get("machine"))
    clauses.push(`machine_id=${bind(id(params.get("machine")))}`);
  if (params.get("service")) {
    const s = bind(id(params.get("service")));
    clauses.push(
      `(service_id=${s} OR (service_id IS NULL AND machine_id=(SELECT machine_id FROM ephor_service WHERE id=${s})))`,
    );
  }
  if (params.get("finding"))
    clauses.push(`finding_id=${bind(text(params.get("finding"), 64))}`);
  if (params.get("kind"))
    clauses.push(`kind=${bind(text(params.get("kind"), 80))}`);
  if (params.get("q")) {
    const q = bind(
      `%${text(params.get("q"), 200)
        .toLowerCase()
        .replace(/[\\%_]/g, "\\$&")}%`,
    );
    clauses.push(
      `(LOWER(action) LIKE ${q} ESCAPE '\\' OR LOWER(actor) LIKE ${q} ESCAPE '\\' OR LOWER(detail) LIKE ${q} ESCAPE '\\')`,
    );
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<"],
  ] as const)
    if (params.has(key)) {
      const n = Number(params.get(key));
      if (!Number.isSafeInteger(n) || n < 0)
        throw new AuthError("INVALID_SECURITY_FILTER");
      clauses.push(`occurred_at${op}${bind(n)}`);
    }
  if (params.get("before")) {
    const m = /^(\d+):([a-f0-9-]{36,64})$/.exec(params.get("before") ?? "");
    if (!m || !Number.isSafeInteger(Number(m[1])))
      throw new AuthError("INVALID_SECURITY_CURSOR");
    const t = bind(Number(m[1])),
      key = bind(m[2]);
    clauses.push(`(occurred_at<${t} OR (occurred_at=${t} AND id<${key}))`);
  }
  const retention = bind(Date.now());
  clauses.push(
    `occurred_at>=CAST(${retention} AS BIGINT)-CAST((SELECT retention_days FROM ephor_security_settings WHERE id=1) AS BIGINT)*86400000`,
  );
  const rows = await sql.query(
    `SELECT * FROM (
    SELECT id,machine_id,service_id,finding_id,occurred_at,received_at,kind,actor,action,outcome,detail FROM ephor_security_event
    UNION ALL
    SELECT id,CASE WHEN target_type='machine' THEN target_id WHEN target_type='service' THEN (SELECT machine_id FROM ephor_service WHERE id=target_id) ELSE NULL END,
      CASE WHEN target_type='service' THEN target_id ELSE NULL END,NULL,occurred_at,occurred_at,'panel',actor_name,action,outcome,COALESCE(target_name,'')
      FROM ephor_activity
    UNION ALL
    SELECT a.id,CASE WHEN a.event LIKE 'machine.%' THEN a.subject ELSE NULL END,
      CASE WHEN a.event LIKE 'service.%' THEN a.subject ELSE NULL END,NULL,a.occurred_at,a.occurred_at,'account','Not recorded',a.event,'recorded',''
      FROM ephor_auth_audit a WHERE NOT EXISTS(SELECT 1 FROM ephor_activity p WHERE p.id=a.id)
    ) events WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC,id DESC LIMIT 101`,
    values,
  );
  const items = rows.slice(0, 100).map(
    (r): SecurityEvent => ({
      id: String(r.id),
      machineId: r.machine_id as string | null,
      serviceId: r.service_id as string | null,
      findingId: r.finding_id as string | null,
      occurredAt: Number(r.occurred_at),
      receivedAt: Number(r.received_at),
      kind: String(r.kind),
      actor: String(r.actor),
      action: String(r.action),
      outcome: String(r.outcome),
      detail: String(r.detail),
    }),
  );
  return {
    items,
    nextCursor:
      rows.length > 100 && items.length
        ? `${items.at(-1)?.occurredAt}:${items.at(-1)?.id}`
        : null,
  };
}
