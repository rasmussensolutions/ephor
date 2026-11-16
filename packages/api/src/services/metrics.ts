import { AuthError, type Sql } from "../auth/store";
import { object } from "./spec";

export interface ServiceMetrics {
  cpuPercent: number | null;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytesPerSecond: number | null;
  networkTxBytesPerSecond: number | null;
  uptimeSeconds: number;
  processes: number;
  restarts: number;
}
export interface ServiceRuntime {
  catalog?: import("./catalog").CatalogRuntime;
  status: string;
  container: string;
  logs: string;
  metrics: ServiceMetrics | null;
}
export interface MetricsHistory {
  from: number;
  to: number;
  interval: number;
  points: {
    timestamp: number;
    cpuPercent: number | null;
    memoryBytes: number | null;
    networkRxBytesPerSecond: number | null;
    networkTxBytesPerSecond: number | null;
  }[];
}
export const METRIC_RETENTION = 24 * 60 * 60 * 1000;
export function readMetrics(value: unknown): ServiceMetrics | null {
  if (value === undefined || value === null) return null;
  const input = object(value);
  function number(
    key: string,
    max: number,
    nullable = false,
    integer = false,
  ): number | null {
    const v = input[key];
    if (nullable && v === null) return null;
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < 0 ||
      v > max ||
      (integer && !Number.isSafeInteger(v))
    )
      throw new AuthError("INVALID_SERVICE_METRICS");
    return v;
  }
  return {
    cpuPercent: number("cpuPercent", 100, true),
    memoryBytes: number(
      "memoryBytes",
      Number.MAX_SAFE_INTEGER,
      false,
      true,
    ) as number,
    memoryLimitBytes: number(
      "memoryLimitBytes",
      Number.MAX_SAFE_INTEGER,
      false,
      true,
    ) as number,
    networkRxBytesPerSecond: number("networkRxBytesPerSecond", 1e15, true),
    networkTxBytesPerSecond: number("networkTxBytesPerSecond", 1e15, true),
    uptimeSeconds: number("uptimeSeconds", 1e12, false, true) as number,
    processes: number("processes", 1e9, false, true) as number,
    restarts: number("restarts", 1e9, false, true) as number,
  };
}
export async function recordMetrics(
  sql: Sql,
  id: string,
  metrics: ServiceMetrics,
  now: number,
  component?: string,
) {
  if (component) {
    await sql.query(
      "INSERT INTO ephor_component_metric (service_id,component,bucket,observed_at,cpu,memory,rx,tx) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (service_id,component,bucket) DO UPDATE SET observed_at=excluded.observed_at,cpu=excluded.cpu,memory=excluded.memory,rx=excluded.rx,tx=excluded.tx WHERE excluded.observed_at >= ephor_component_metric.observed_at",
      [
        id,
        component,
        Math.floor(now / 60000) * 60000,
        now,
        metrics.cpuPercent,
        metrics.memoryBytes,
        metrics.networkRxBytesPerSecond,
        metrics.networkTxBytesPerSecond,
      ],
    );
  } else
    await sql.query(
      "INSERT INTO ephor_service_metric (service_id,bucket,observed_at,cpu,memory,rx,tx) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (service_id,bucket) DO UPDATE SET observed_at=excluded.observed_at,cpu=excluded.cpu,memory=excluded.memory,rx=excluded.rx,tx=excluded.tx WHERE excluded.observed_at >= ephor_service_metric.observed_at",
      [
        id,
        Math.floor(now / 60000) * 60000,
        now,
        metrics.cpuPercent,
        metrics.memoryBytes,
        metrics.networkRxBytesPerSecond,
        metrics.networkTxBytesPerSecond,
      ],
    );
  await pruneServiceMetrics(sql, now);
}
export async function metricsHistory(
  sql: Sql,
  id: string,
  range: string,
  now = Date.now(),
  component?: string,
): Promise<MetricsHistory> {
  const ranges: Record<string, [number, number]> = {
    "15m": [15 * 60000, 60000],
    "1h": [3600000, 60000],
    "6h": [6 * 3600000, 120000],
    "24h": [METRIC_RETENTION, 300000],
  };
  const selection = Object.hasOwn(ranges, range) ? ranges[range] : undefined;
  if (!selection) throw new AuthError("INVALID_METRICS_RANGE");
  const [duration, interval] = selection;
  await pruneServiceMetrics(sql, now);
  const rows = await sql.query<{
    bucket: number;
    cpu: number | null;
    memory: number;
    rx: number | null;
    tx: number | null;
  }>(
    component
      ? "SELECT bucket,cpu,memory,rx,tx FROM ephor_component_metric WHERE service_id=$1 AND observed_at >= $2 AND observed_at <= $3 AND component=$4 ORDER BY bucket LIMIT 1441"
      : "SELECT bucket,cpu,memory,rx,tx FROM ephor_service_metric WHERE service_id=$1 AND observed_at >= $2 AND observed_at <= $3 ORDER BY bucket LIMIT 1441",
    component
      ? [id, now - duration, now, component]
      : [id, now - duration, now],
  );
  const grouped = new Map<number, typeof rows>();
  for (const r of rows) {
    const t = Math.floor(Number(r.bucket) / interval) * interval;
    const group = grouped.get(t) ?? [];
    group.push(r);
    grouped.set(t, group);
  }
  const points: MetricsHistory["points"] = [];
  for (
    let timestamp = Math.ceil((now - duration) / interval) * interval;
    timestamp <= now;
    timestamp += interval
  ) {
    const group = grouped.get(timestamp) ?? [];
    const average = (key: "cpu" | "memory" | "rx" | "tx") => {
      const values = group
        .map((r) => r[key])
        .filter((v): v is number => v !== null)
        .map(Number);
      return values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : null;
    };
    points.push({
      timestamp,
      cpuPercent: average("cpu"),
      memoryBytes: average("memory"),
      networkRxBytesPerSecond: average("rx"),
      networkTxBytesPerSecond: average("tx"),
    });
  }
  return { from: now - duration, to: now, interval, points };
}

export async function pruneServiceMetrics(sql: Sql, now = Date.now()) {
  await sql.query("DELETE FROM ephor_component_metric WHERE observed_at < $1", [
    now - METRIC_RETENTION,
  ]);
  await sql.query("DELETE FROM ephor_service_metric WHERE observed_at < $1", [
    now - METRIC_RETENTION,
  ]);
}
