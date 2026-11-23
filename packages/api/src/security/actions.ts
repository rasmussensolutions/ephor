import { AuthError, type Sql } from "../auth/store";
import {
  findingFilter,
  findingJoins,
  findingPriority,
  stoppedResource,
} from "./finding-filter";
import type {
  SecurityAction,
  SecurityActionList,
  Vulnerability,
} from "./types";

export function packageLayer(target: string): "os" | "language" | "other" {
  if (/^sha256:[a-f0-9]{64} \(.+\)$/.test(target)) return "os";
  if (
    /^(Node\.js|Python|Ruby|Java|\.NET|Rust|PHP)$/i.test(target) ||
    /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$/.test(
      target,
    )
  )
    return "language";
  return "other";
}

/** Page resources first, then aggregate every matching finding in those resources. */
export async function securityActions(
  sql: Sql,
  params: URLSearchParams,
): Promise<SecurityActionList> {
  const { values, clauses, bind } = findingFilter(params);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const baseValues = [...values];
  let having = "";
  const before = params.get("before");
  if (before) {
    const match = /^([0-4]):((?:machine|service):[a-f0-9-]{36})$/.exec(before);
    if (!match) throw new AuthError("INVALID_SECURITY_CURSOR");
    const rank = bind(Number(match[1])),
      target = bind(match[2]);
    having = `HAVING MIN(${findingPriority})>${rank} OR (MIN(${findingPriority})=${rank} AND f.target>${target})`;
  }
  const targets = await sql.query(
    `SELECT f.target,MIN(${findingPriority}) AS priority ${findingJoins} ${where} GROUP BY f.target ${having} ORDER BY priority,f.target LIMIT 21`,
    values,
  );
  const page = targets.slice(0, 20);
  if (!page.length) return { items: [], nextCursor: null };
  const targetParams = page.map((t) => {
    baseValues.push(t.target);
    return `$${baseValues.length}`;
  });
  const rows = await sql.query(
    `SELECT f.id,f.target,f.machine_id,f.service_id,f.rule,f.category,f.severity,f.detail,f.last_seen,m.name AS machine_name,s.name AS service_name,s.runtime_at,CASE WHEN ${stoppedResource} THEN 1 ELSE 0 END AS stopped ${findingJoins} ${where ? `${where} AND` : "WHERE"} f.target IN (${targetParams.join(",")}) ORDER BY f.target,f.id`,
    baseValues,
  );
  const groups = new Map<
    string,
    { action: SecurityAction; advisories: Set<string>; images: Set<string> }
  >();
  for (const row of rows) {
    const target = String(row.target);
    let group = groups.get(target);
    if (!group) {
      group = {
        action: {
          target,
          machineId: String(row.machine_id),
          machineName: String(row.machine_name),
          serviceId: row.service_id as string | null,
          serviceName: row.service_name as string | null,
          stopped: Number(row.stopped) === 1,
          count: 0,
          advisoryCount: 0,
          imageCount: 0,
          counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          layers: { os: 0, language: 0, other: 0 },
          fixesAvailable: 0,
          noFixReported: 0,
          configurationCount: 0,
          lastSeen: 0,
          sampleFindingId: String(row.id),
        },
        advisories: new Set(),
        images: new Set(),
      };
      groups.set(target, group);
    }
    const a = group.action;
    a.count++;
    a.counts[row.severity as keyof typeof a.counts]++;
    a.lastSeen = Math.max(a.lastSeen, Number(row.last_seen));
    if (row.category !== "vulnerability") {
      a.configurationCount++;
      continue;
    }
    group.advisories.add(String(row.rule));
    const detail = JSON.parse(String(row.detail)) as Vulnerability | null;
    if (detail) {
      group.images.add(detail.digest);
      a.layers[packageLayer(detail.target)]++;
      if (detail.fixedVersion.trim()) a.fixesAvailable++;
      else a.noFixReported++;
    } else {
      a.layers.other++;
      a.noFixReported++;
    }
  }
  const last = page.at(-1);
  return {
    items: page.flatMap((t) => {
      const g = groups.get(String(t.target));
      return g
        ? [
            {
              ...g.action,
              advisoryCount: g.advisories.size,
              imageCount: g.images.size,
            },
          ]
        : [];
    }),
    nextCursor:
      targets.length > 20 && last ? `${last.priority}:${last.target}` : null,
  };
}
