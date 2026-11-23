import type {
  ServiceDomains,
  ServicePresentation,
  ServiceRuntime,
  ServiceSource,
  ServiceSpec,
  ServiceTopology,
} from "@ephor/api/services";
export interface Service {
  id: string;
  machineId: string;
  name: string;
  presentation?: ServicePresentation;
  domain: string | null;
  domains?: ServiceDomains;
  spec: Omit<ServiceSpec, "environment" | "registry"> & {
    environment: string[];
    registry: { server: string; username: string } | null;
  };
  source: ServiceSource;
  autoDeploy: boolean;
  currentDeployment: string | null;
  variableConnections?: { serviceId: string; variables: string[] }[];
  variablesPending?: boolean;
  resourcesPending?: boolean;
  requiredWorkerProtocol?: number;
  runtime: ServiceRuntime | null;
  runtimeAt: number;
  topology?: ServiceTopology;
}
export interface Deployment {
  id: string;
  service_id: string;
  status: string;
  action: string;
  created_at: number;
  updated_at: number;
  source_ref: string | null;
  digest: string | null;
  error: string | null;
}
export interface ServiceList {
  services: Service[];
  deployments: Deployment[];
  workers: { machine_id: string; last_seen: number; version?: string }[];
  builds: {
    id: string;
    service_id: string;
    status: string;
    phase: string;
    logs: string;
    error: string | null;
    created_at: number;
    updated_at?: number;
  }[];
}

export function bytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
export function uptime(seconds: number) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
export function serviceStatus(s: Service, data: ServiceList) {
  const job = data.deployments.find(
    (d) => d.service_id === s.id && ["queued", "running"].includes(d.status),
  );
  if (job)
    return job.action === "stop"
      ? "Stopping"
      : job.action === "backup"
        ? "Backing up"
        : job.action === "restore"
          ? "Restoring"
          : "Deploying";
  const build = data.builds.find(
    (b) =>
      b.service_id === s.id &&
      ["queued", "running", "built"].includes(b.status),
  );
  if (build) return "Building";
  if (s.runtimeAt && Date.now() - s.runtimeAt > 120000) return "Unavailable";
  if (s.runtime?.catalog?.recoveryRequired) {
    const completed = data.deployments.find(
      (d) =>
        d.service_id === s.id &&
        ["deploy", "stop", "backup", "restore"].includes(d.action) &&
        ["succeeded", "failed"].includes(d.status),
    );
    // The worker reports telemetry independently of deployment receipts. Its
    // durable recovery marker is also set during normal startup. A successful
    // receipt can arrive before the next snapshot clears that marker, including
    // an already-in-flight snapshot. Wait for fresh telemetry instead of telling
    // the operator to recover an app that just deployed successfully.
    if (
      completed?.status === "succeeded" &&
      (s.runtimeAt <= completed.updated_at ||
        Date.now() - completed.updated_at < 60000)
    )
      return "Updating status";
    return "Recovery required";
  }
  if (s.runtime)
    return (
      (
        {
          running: "Running",
          stopped: "Stopped",
          unhealthy: "Unhealthy",
          missing: "Missing",
        } as Record<string, string>
      )[s.runtime.status] ?? "Unavailable"
    );
  return data.deployments.find((d) => d.service_id === s.id)?.status ===
    "failed" ||
    data.builds.find((b) => b.service_id === s.id)?.status === "failed"
    ? "Failed"
    : "Not deployed";
}
export function serviceNeedsAttention(status: string) {
  return [
    "Failed",
    "Unhealthy",
    "Missing",
    "Unavailable",
    "Recovery required",
  ].includes(status);
}
export function currentMetrics(s: Service) {
  return s.runtimeAt > Date.now() - 120000 &&
    ["running", "unhealthy"].includes(s.runtime?.status ?? "")
    ? (s.runtime?.metrics ?? null)
    : null;
}
export const code =
  "max-h-96 overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded-lg border bg-background p-4 font-mono text-xs leading-relaxed";
