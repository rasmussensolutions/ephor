import type { Machine } from "@ephor/api/machines";

export function machineSummary(machines: Machine[], now: number) {
  const active = machines.filter(
    (machine) => !["revoked", "expired"].includes(machine.status),
  );
  const online = active.filter(
    (machine) =>
      machine.status === "online" &&
      machine.lastSeen !== null &&
      now - machine.lastSeen < 60_000,
  );
  const waiting = active.filter((machine) =>
    ["pending", "connecting"].includes(machine.status),
  ).length;
  let cores = 0;
  let usedCores = 0;
  let memoryUsed = 0;
  let memoryTotal = 0;
  let diskUsed = 0;
  let diskTotal = 0;
  let disksReported = 0;
  let disksHigh = 0;
  let busiest: { name: string; percent: number } | null = null;
  for (const machine of online) {
    const metrics = machine.telemetry;
    if (!metrics) continue;
    cores += metrics.cpuCount;
    usedCores += metrics.cpuCount * (metrics.cpuPercent / 100);
    memoryUsed += metrics.memoryUsed;
    memoryTotal += metrics.memoryTotal;
    if (!busiest || metrics.cpuPercent > busiest.percent) {
      busiest = { name: machine.name, percent: metrics.cpuPercent };
    }
    const root = metrics.disks.find((disk) => disk.mount === "/");
    if (root && root.total > 0) {
      diskUsed += root.used;
      diskTotal += root.total;
      disksReported++;
      if (root.used / root.total > 0.85) disksHigh++;
    }
  }
  return {
    total: active.length,
    online: online.length,
    offline: active.length - online.length - waiting,
    waiting,
    cpuPercent: cores ? (usedCores / cores) * 100 : null,
    cores,
    busiest,
    memoryPercent: memoryTotal ? (memoryUsed / memoryTotal) * 100 : null,
    memoryUsed,
    memoryTotal,
    diskPercent: diskTotal ? (diskUsed / diskTotal) * 100 : null,
    diskUsed,
    diskTotal,
    disksReported,
    disksHigh,
  };
}
