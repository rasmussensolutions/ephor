import type { Machine } from "@ephor/api/machines";
import type { ServiceList } from "./services";

// A machine's monitoring agent and deployment worker report independently.
export function catalogMachineIssue(
  machine: Pick<Machine, "id" | "status">,
  workers: ServiceList["workers"],
  now = Date.now(),
): string | null {
  if (machine.status === "revoked") return "Machine disconnected";
  if (machine.status === "expired") return "Connection expired";
  if (machine.status === "pending") return "Waiting for machine connection";
  const worker = workers.find((worker) => worker.machine_id === machine.id);
  if (!worker || !Number(worker.last_seen))
    return "Waiting for deployment worker";
  if (!(Number(worker.last_seen) > now - 120_000))
    return "Deployment worker offline";
  if (!(Number(worker.version) >= 3)) return "Update deployment worker";
  return null;
}
