import type { Machine } from "@ephor/api/machines";
import { StatusIndicator } from "@/components/status-indicator";

const labels: Record<string, string> = {
  pending: "Awaiting enrollment",
  connecting: "Waiting for metrics",
  online: "Online",
  offline: "Offline",
  revoked: "Disconnected",
  expired: "Enrollment expired",
};
export function MachineStatus({ status }: { status: Machine["status"] }) {
  return (
    <StatusIndicator
      status={labels[status] ?? status}
      tone={
        status === "online"
          ? "healthy"
          : status === "connecting"
            ? "busy"
            : "neutral"
      }
    />
  );
}
