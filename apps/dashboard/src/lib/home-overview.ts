import type { ActivityItem } from "@ephor/api/activity";
import type { Machine } from "@ephor/api/machines";
import {
  type ServiceList,
  serviceNeedsAttention,
  serviceStatus,
} from "./services";

export interface BackupOverview {
  destinations: { id: string; name: string; status: string }[];
  plans: {
    id: string;
    service_id: string;
    destination_id: string;
    frequency: string;
    created_at: number;
    last_success: number | null;
    last_status: string | null;
  }[];
}
export interface AttentionItem {
  id: string;
  name: string;
  detail: string;
  action: string;
  href: string;
  severity: "error" | "warning";
}
export const machineHref = (id: string) =>
  `/machines/${encodeURIComponent(id)}`;
export const serviceHref = (id: string) =>
  `/services/${encodeURIComponent(id)}`;
// The server reports connectivity. An old browser snapshot is stale, not
// evidence that a machine went offline while this tab was suspended.
export function currentMachineStatus(machine: Machine, _now: number) {
  return machine.status;
}
export function activeMachines(machines: Machine[]) {
  return machines.filter((m) => !["revoked", "expired"].includes(m.status));
}
export function backupState(
  plan: BackupOverview["plans"][number],
  now: number,
) {
  if (plan.last_status === "failed") return "failed";
  // Older panels may not yet return freshness fields. Never infer health from
  // the capped job history or treat an absent timestamp as a successful backup.
  if (!Number.isFinite(plan.created_at)) return "unknown";
  const baseline = plan.last_success ?? plan.created_at;
  if (
    plan.frequency !== "manual" &&
    now - baseline >
      (plan.frequency === "weekly" ? 7 : 1) * 86_400_000 + 3_600_000
  )
    return "overdue";
  return plan.last_success == null ? "pending" : "verified";
}
export function homeOverview(
  machines: Machine[],
  services: ServiceList | null,
  backups: BackupOverview | null,
  now: number,
) {
  const attention: AttentionItem[] = [];
  const inventory = activeMachines(machines);
  const machineMap = new Map(inventory.map((m) => [m.id, m]));
  const serviceMap = new Map(services?.services.map((s) => [s.id, s]) ?? []);
  for (const machine of inventory) {
    const status = currentMachineStatus(machine, now);
    if (status === "offline") {
      attention.push({
        id: `machine:${machine.id}`,
        name: machine.name,
        detail: "Machine offline · Check its connection and last report.",
        action: "View machine",
        href: machineHref(machine.id),
        severity: "error",
      });
    } else if (status === "online") {
      for (const disk of machine.telemetry?.disks ?? []) {
        if (disk.total > 0 && disk.used / disk.total > 0.85)
          attention.push({
            id: `disk:${machine.id}:${disk.mount}`,
            name: machine.name,
            detail: `${disk.mount} disk is ${Math.round((disk.used / disk.total) * 100)}% full · Review storage usage.`,
            action: "Review storage",
            href: machineHref(machine.id),
            severity: "warning",
          });
      }
    }
  }
  const deploying = new Set<string>();
  let running = 0;
  let unknownServices = 0;
  for (const service of services?.services ?? []) {
    if (!services) break;
    const machine = machineMap.get(service.machineId);
    const status = serviceStatus(service, services);
    if (
      status === "Running" &&
      machine &&
      currentMachineStatus(machine, now) === "online"
    )
      running++;
    if (
      !service.runtime ||
      !service.runtimeAt ||
      now - service.runtimeAt >= 120_000
    )
      unknownServices++;
    if (["Deploying", "Building"].includes(status)) deploying.add(service.id);
    // A machine outage explains its unavailable services; show the root problem once.
    if (machine && currentMachineStatus(machine, now) === "offline") continue;
    const latestDeployment = services.deployments.find(
      (d) =>
        d.service_id === service.id &&
        ["deploy", "rollback"].includes(d.action),
    );
    const latestBuild = services.builds.find(
      (b) => b.service_id === service.id,
    );
    const buildFailed =
      latestBuild?.status === "failed" &&
      (!latestDeployment ||
        latestBuild.created_at >= latestDeployment.created_at);
    const deploymentFailed = latestDeployment?.status === "failed";
    const failed =
      !deploying.has(service.id) && (buildFailed || deploymentFailed);
    if (serviceNeedsAttention(status) || failed)
      attention.push({
        id: `service:${service.id}`,
        name: service.name,
        detail: failed
          ? "Latest deployment failed · Review the build and deployment details."
          : `${status} · Review the service and its logs.`,
        action: "View service",
        href: serviceHref(service.id),
        severity: status === "Unavailable" ? "warning" : "error",
      });
  }
  let verifiedBackups = 0;
  let pendingBackups = 0;
  for (const plan of backups?.plans ?? []) {
    const state = backupState(plan, now);
    const destination = backups?.destinations.find(
      (d) => d.id === plan.destination_id,
    );
    if (state === "verified" && destination?.status === "ready")
      verifiedBackups++;
    if (state === "pending" || state === "unknown") pendingBackups++;
    if (state === "failed" || state === "overdue")
      attention.push({
        id: `backup:${plan.id}`,
        name: serviceMap.get(plan.service_id)?.name ?? "Service backup",
        detail:
          state === "failed"
            ? "Latest backup failed · Check storage and retry the backup."
            : "Scheduled backup overdue · No verified copy within the schedule and one-hour grace period.",
        action: "Review backups",
        href: "/settings/backups",
        severity: "warning",
      });
  }
  for (const destination of backups?.destinations ?? []) {
    if (destination.status === "failed")
      attention.push({
        id: `storage:${destination.id}`,
        name: destination.name,
        detail: "Backup storage check failed · Review the connection settings.",
        action: "Review storage",
        href: "/settings/backups",
        severity: "warning",
      });
  }
  attention.sort(
    (a, b) =>
      Number(b.severity === "error") - Number(a.severity === "error") ||
      a.name.localeCompare(b.name),
  );
  const affectedMachines = new Set(
    attention
      .filter((a) => a.id.startsWith("machine:") || a.id.startsWith("disk:"))
      .map((a) => a.href),
  );
  const sortedMachines = [...inventory].sort(
    (a, b) =>
      Number(affectedMachines.has(machineHref(b.id))) -
        Number(affectedMachines.has(machineHref(a.id))) ||
      a.name.localeCompare(b.name),
  );
  return {
    attention,
    machines: sortedMachines,
    online: inventory.filter((m) => currentMachineStatus(m, now) === "online")
      .length,
    running,
    deploying: deploying.size,
    unknownServices,
    verifiedBackups,
    pendingBackups,
  };
}

export function activityHref(
  item: ActivityItem,
  machines: Machine[],
  services: ServiceList | null,
) {
  const id = item.target.id;
  if (id && item.target.type === "machine" && machines.some((m) => m.id === id))
    return machineHref(id);
  if (
    id &&
    item.target.type === "service" &&
    services?.services.some((s) => s.id === id)
  )
    return serviceHref(id);
  return "/activity";
}
