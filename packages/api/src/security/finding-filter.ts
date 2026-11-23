import { AuthError } from "../auth/store";
import { findingStatuses, severities } from "./types";
import { id, text } from "./validation";

export const findingJoins = `FROM ephor_security_finding f JOIN ephor_machine m ON m.id=f.machine_id LEFT JOIN ephor_service s ON s.id=f.service_id LEFT JOIN ephor_deployment d ON d.id=s.current_deployment`;
export const findingPriority =
  "CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
export const stoppedResource = "(m.state<>'active' OR d.action='stop')";

export function findingFilter(params: URLSearchParams) {
  const values: unknown[] = [],
    clauses: string[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (params.get("machine"))
    clauses.push(`f.machine_id=${bind(id(params.get("machine")))}`);
  if (params.get("id")) {
    const key = text(params.get("id"), 64);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new AuthError("INVALID_SECURITY_ID");
    clauses.push(`f.id=${bind(key)}`);
  }
  const resource = params.get("resource");
  if (resource) {
    const match = /^(machine|service):([a-f0-9-]{36})$/.exec(resource);
    if (!match) throw new AuthError("INVALID_SECURITY_ID");
    id(match[2]);
    clauses.push(`f.target=${bind(resource)}`);
  }
  if (params.get("service")) {
    const service = id(params.get("service"));
    clauses.push(
      `(f.service_id=${bind(service)} OR (f.service_id IS NULL AND f.machine_id=(SELECT machine_id FROM ephor_service WHERE id=${bind(service)})))`,
    );
  }
  const effective = `CASE WHEN f.status='accepted' AND f.accepted_until IS NOT NULL AND f.accepted_until<=${bind(Date.now())} THEN 'open' ELSE f.status END`;
  const state = params.get("status") ?? "active";
  if (state === "active")
    clauses.push(`(${effective}) IN ('open','acknowledged')`);
  else if (state !== "all") {
    if (!findingStatuses.includes(state as never))
      throw new AuthError("INVALID_SECURITY_FILTER");
    clauses.push(`(${effective})=${bind(state)}`);
  }
  const workload = params.get("workload") ?? "all";
  if (workload === "active")
    clauses.push(`m.state='active' AND (d.action IS NULL OR d.action<>'stop')`);
  else if (workload === "stopped") clauses.push(stoppedResource);
  else if (workload !== "all") throw new AuthError("INVALID_SECURITY_FILTER");
  if (params.get("severity")) {
    const severity = params.get("severity");
    if (!severities.includes(severity as never))
      throw new AuthError("INVALID_SECURITY_FILTER");
    clauses.push(`f.severity=${bind(severity)}`);
  }
  if (params.get("category"))
    clauses.push(`f.category=${bind(text(params.get("category"), 40))}`);
  if (params.get("q")) {
    const q = bind(
      `%${text(params.get("q"), 200)
        .toLowerCase()
        .replace(/[\\%_]/g, "\\$&")}%`,
    );
    clauses.push(
      `(LOWER(f.title) LIKE ${q} ESCAPE '\\' OR LOWER(f.evidence) LIKE ${q} ESCAPE '\\' OR LOWER(COALESCE(s.name,m.name)) LIKE ${q} ESCAPE '\\')`,
    );
  }
  return { values, clauses, bind, effective };
}
