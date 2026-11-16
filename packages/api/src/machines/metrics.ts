import { AuthError, type Sql } from "../auth/store";
import type { Telemetry } from "./store";

export const MACHINE_METRIC_RETENTION = 24 * 60 * 60 * 1000;
export interface MachineMetricsHistory {
  from: number;
  to: number;
  interval: number;
  points: {
    timestamp: number;
    cpuPercent: number | null;
    memoryBytes: number | null;
    diskPercent: number | null;
  }[];
}

export async function recordMachineMetrics(
  sql: Sql,
  id: string,
  data: Telemetry,
  now: number,
) {
  const root = data.disks.find((disk) => disk.mount === "/");
  // Recheck state so a revoked credential cannot append history after authentication.
  await sql.query(
    `INSERT INTO ephor_machine_metric (machine_id,bucket,observed_at,cpu,memory,disk)
     SELECT id,$2,$3,$4,$5,$6 FROM ephor_machine WHERE id=$1 AND state='active'
     ON CONFLICT (machine_id,bucket) DO UPDATE SET observed_at=excluded.observed_at,
     cpu=excluded.cpu,memory=excluded.memory,disk=excluded.disk
     WHERE excluded.observed_at >= ephor_machine_metric.observed_at`,
    [
      id,
      Math.floor(now / 60000) * 60000,
      now,
      data.cpuPercent,
      data.memoryUsed,
      root ? (root.used / root.total) * 100 : null,
    ],
  );
}

export async function machineMetricsHistory(
  sql: Sql,
  id: string,
  range: string,
  now = Date.now(),
): Promise<MachineMetricsHistory> {
  const ranges: Record<string, [number, number]> = {
    "15m": [15 * 60000, 60000],
    "1h": [3600000, 60000],
    "6h": [6 * 3600000, 120000],
    "24h": [MACHINE_METRIC_RETENTION, 300000],
  };
  const selection = Object.hasOwn(ranges, range) ? ranges[range] : undefined;
  if (!selection) throw new AuthError("INVALID_METRICS_RANGE");
  const [duration, interval] = selection;
  const rows = await sql.query<{
    bucket: number;
    cpu: number;
    memory: number;
    disk: number | null;
  }>(
    "SELECT bucket,cpu,memory,disk FROM ephor_machine_metric WHERE machine_id=$1 AND observed_at >= $2 AND observed_at <= $3 ORDER BY bucket LIMIT 1441",
    [id, now - duration, now],
  );
  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    const timestamp = Math.floor(Number(row.bucket) / interval) * interval;
    const group = grouped.get(timestamp) ?? [];
    group.push(row);
    grouped.set(timestamp, group);
  }
  const points: MachineMetricsHistory["points"] = [];
  for (
    let timestamp = Math.floor((now - duration) / interval) * interval;
    timestamp <= now;
    timestamp += interval
  ) {
    const group = grouped.get(timestamp) ?? [];
    const average = (key: "cpu" | "memory" | "disk") => {
      const values = group
        .map((row) => row[key])
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
      diskPercent: average("disk"),
    });
  }
  return {
    from: points[0]?.timestamp ?? now - duration,
    to: now,
    interval,
    points,
  };
}

export async function pruneMachineMetrics(sql: Sql, now = Date.now()) {
  await sql.query("DELETE FROM ephor_machine_metric WHERE observed_at < $1", [
    now - MACHINE_METRIC_RETENTION,
  ]);
}
