import { StatusIndicator } from "@/components/status-indicator";
export function ServiceStatus({
  status,
  badge = false,
}: {
  status: string;
  badge?: boolean;
}) {
  const color =
    status === "Running"
      ? "healthy"
      : [
            "Building",
            "Deploying",
            "Stopping",
            "Backing up",
            "Restoring",
            "Updating status",
          ].includes(status)
        ? "busy"
        : ["Failed", "Unhealthy", "Missing", "Recovery required"].includes(
              status,
            )
          ? "error"
          : "neutral";
  return <StatusIndicator status={status} tone={color} badge={badge} />;
}
