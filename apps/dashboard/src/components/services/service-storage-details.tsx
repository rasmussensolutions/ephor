import { serviceStorage } from "@/lib/service-storage";
import type { Service } from "@/lib/services";

export function ServiceStorageDetails({
  service,
  component,
}: {
  service: Service;
  component?: string;
}) {
  const volumes = serviceStorage(service, component);
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-medium">Persistent storage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Data in these volumes persists across restarts and deployments.
        </p>
      </div>
      {volumes.map((volume) => (
        <div
          key={volume.target}
          className="space-y-2 rounded-xl border bg-card p-4 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all font-medium">{volume.name}</h3>
            <span className="text-xs text-muted-foreground">
              {volume.status}
            </span>
          </div>
          <p className="break-all font-mono text-xs">{volume.target}</p>
          {volume.runtimeName && (
            <p className="break-all text-xs text-muted-foreground">
              Volume: {volume.runtimeName}
            </p>
          )}
        </div>
      ))}
      {volumes.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Included in app backups. Manage recovery points in the app’s settings.
        </p>
      )}
      {!volumes.length && (
        <p className="text-sm text-muted-foreground">
          No persistent volumes configured.
        </p>
      )}
      {volumes.some((v) => v.status === "Needs deployment") && (
        <p className="text-xs text-muted-foreground">
          Deploy this service to apply its configured storage.
        </p>
      )}
      {volumes.some((v) => v.status === "Awaiting report") && (
        <p className="text-xs text-muted-foreground">
          Waiting for a current worker report to confirm storage attachments.
        </p>
      )}
    </section>
  );
}
