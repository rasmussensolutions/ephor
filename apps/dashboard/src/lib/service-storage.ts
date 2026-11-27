import type { Service } from "./services";

export const storageFooterHeight = 40;
export type StorageVolume = {
  name: string;
  target: string;
  runtimeName?: string;
  status: "Needs deployment" | "Awaiting report" | "Attached" | "Mounted";
};

// Workers namespace volume names with the service and deployment UUID. Keep
// the logical name readable, including after a restore creates a new generation.
function volumeLabel(service: Service, name: string) {
  const prefix = [
    `ephor-data-${service.id}-`,
    `tenet-data-${service.id}-`,
  ].find((value) => name.startsWith(value));
  if (!prefix) return name;
  return name
    .slice(prefix.length)
    .replace(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
      "",
    );
}

export function serviceStorage(
  service: Service,
  component?: string,
  now = Date.now(),
): StorageVolume[] {
  const configured = component
    ? (
        service.topology?.components.find((c) => c.name === component)
          ?.volumes ?? []
      ).map((target) => ({ name: "", target }))
    : (service.spec?.volumes ?? []).map((v) => ({
        name: v.name,
        target: v.mountPath,
      }));
  const runtime = service.runtime?.catalog;
  return configured.map(({ name, target }) => {
    const report = runtime?.volumes.find(
      (v) =>
        v.component === (component ?? "web") &&
        v.target === target &&
        (!name || volumeLabel(service, v.name) === name),
    );
    const status = !service.currentDeployment
      ? "Needs deployment"
      : !runtime || service.runtimeAt < now - 120000
        ? "Awaiting report"
        : !report
          ? "Needs deployment"
          : runtime.components.some(
                (c) =>
                  c.name === (component ?? "web") &&
                  (c.status === "running" || c.status === "unhealthy"),
              )
            ? "Mounted"
            : "Attached";
    return {
      name: name || (report ? volumeLabel(service, report.name) : target),
      target,
      runtimeName: report?.name,
      status,
    };
  });
}
