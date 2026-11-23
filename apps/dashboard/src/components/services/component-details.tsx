import type { MachineList } from "@ephor/api/machines";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { useState } from "react";
import { ComponentVariables } from "@/components/services/component-variables";
import { ServiceCharts } from "@/components/services/service-charts";
import { ServiceIcon } from "@/components/services/service-icon";
import { ServiceStatus } from "@/components/services/service-status";
import { Button } from "@/components/ui/button";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useServices } from "@/hooks/use-services";
import {
  componentLabel,
  componentMetrics,
  componentStatus,
} from "@/lib/service-map";
import { bytes, type ServiceList, uptime } from "@/lib/services";
import { DisplayNameEditor } from "./display-name-editor";

export function ComponentDetails({
  id,
  name,
  initial,
  onApp,
}: {
  id: string;
  name: string;
  initial: { data: ServiceList; machines: MachineList };
  onApp?: () => void;
}) {
  const { data, error } = useServices(initial, id);
  const [tab, setTab] = useState<"Metrics" | "Logs" | "Variables">("Metrics");
  const service = data.services.find((s) => s.id === id);
  const component = service?.topology?.components.find((c) => c.name === name);
  if (!service || !component)
    return (
      <>
        <SheetTitle>Component unavailable</SheetTitle>
        <SheetDescription>
          This component is no longer part of the app.
        </SheetDescription>
      </>
    );
  const runtime = service.runtime?.catalog?.components.find(
    (c) => c.name === name,
  );
  const metrics = componentMetrics(service, name);
  const stale = service.runtimeAt < Date.now() - 120000;
  const dependencies =
    service.topology?.dependencies.filter((d) => d.from === name) ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="shrink-0 px-5 py-7 pr-16 sm:px-10 sm:py-9 sm:pr-20">
        <div className="flex items-center gap-3">
          <span className="shrink-0">
            <ServiceIcon
              source={{ type: "image" }}
              image={component.image}
              size={32}
            />
          </span>
          <div>
            <SheetTitle className="text-2xl">
              {componentLabel(component, service)}
            </SheetTitle>
            <SheetDescription>
              {name} · Port {component.port}
            </SheetDescription>
          </div>
          <DisplayNameEditor
            id={service.id}
            name={componentLabel(component, service)}
            component={name}
          />
        </div>
      </SheetHeader>
      <fieldset
        aria-label="Component view"
        className="flex shrink-0 gap-6 overflow-x-auto border-b px-5 sm:px-10"
      >
        {(["Metrics", "Logs", "Variables"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
            className={`shrink-0 border-b-2 pb-4 pt-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === value ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {value}
          </button>
        ))}
      </fieldset>
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-5 py-6 sm:px-10 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onApp}
            className="-ml-2 text-muted-foreground"
          >
            <ArrowLeftIcon /> {service.name}
          </Button>
          <ServiceStatus status={componentStatus(service, name)} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {tab === "Metrics" && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [
                  "CPU",
                  metrics?.cpuPercent != null
                    ? `${metrics.cpuPercent.toFixed(1)}%`
                    : "—",
                ],
                ["Memory", metrics ? bytes(metrics.memoryBytes) : "—"],
                ["Uptime", metrics ? uptime(metrics.uptimeSeconds) : "—"],
                ["Restarts", metrics ? String(metrics.restarts) : "—"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-2 text-lg font-medium tabular-nums">
                    {value}
                  </p>
                </div>
              ))}
            </div>
            {runtime && runtime.metrics === undefined && (
              <p className="text-sm text-muted-foreground">
                Update this machine’s worker to receive component metrics and
                logs. App totals remain available in the app view.
              </p>
            )}

            <ServiceCharts id={id} component={name} />
            {dependencies.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-medium">Dependencies</h2>
                {dependencies.map((edge) => (
                  <p key={edge.to} className="rounded-lg border p-3 text-sm">
                    Uses <span className="font-medium">{edge.to}</span>
                    <span className="mt-1 block font-mono text-xs text-muted-foreground">
                      {edge.variables.join(", ")}
                    </span>
                  </p>
                ))}
              </section>
            )}
            {component.volumes.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-medium">Persistent storage</h2>
                {component.volumes.map((path) => (
                  <p
                    key={path}
                    className="break-all rounded-lg border p-3 font-mono text-xs"
                  >
                    {path}
                  </p>
                ))}
                <p className="text-xs text-muted-foreground">
                  Included in app backups.
                </p>
              </section>
            )}
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              {component.image}
            </p>
          </div>
        )}
        {tab === "Logs" && (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{name} logs</h2>
              <span className="text-xs text-muted-foreground">
                {stale && runtime
                  ? "Last received output"
                  : "Recent output · refreshes every 10s"}
              </span>
            </div>
            {runtime?.logs === undefined ? (
              <p className="rounded-xl border p-5 text-sm text-muted-foreground">
                {runtime
                  ? "Update the machine’s worker to receive logs for individual components."
                  : "Waiting for the first component report."}
              </p>
            ) : (
              <pre className="max-h-[55vh] overflow-auto rounded-xl border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
                {runtime.logs || "No recent output from this component."}
              </pre>
            )}
          </section>
        )}
        {tab === "Variables" && <ComponentVariables id={id} name={name} />}
      </div>
    </div>
  );
}
