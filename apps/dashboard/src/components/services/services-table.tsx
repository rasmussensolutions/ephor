import { CubeIcon } from "@phosphor-icons/react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Usage } from "@/components/usage-meter";
import {
  componentLabel,
  componentLayout,
  componentMetrics,
  componentStatus,
  primaryComponent,
} from "@/lib/service-map";
import {
  bytes,
  currentMetrics,
  type Service,
  type ServiceList,
  serviceStatus,
  uptime,
} from "@/lib/services";
import { ServiceDrawer } from "./service-drawer";
import { ServiceIcon } from "./service-icon";
import { ServiceStatus } from "./service-status";
export function ServicesTable({
  services,
  data,
  machines,
  onOpen,
  variant = "default",
  emptyMessage = "No services on this machine.",
}: {
  services: Service[];
  data: ServiceList;
  machines?: { id: string; name: string }[];
  variant?: ComponentProps<typeof Table>["variant"];
  emptyMessage?: string;
  onOpen?: (service: Service, trigger: HTMLElement, component?: string) => void;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<{
    service: Service;
    trigger: HTMLElement;
    component?: string;
  } | null>(null);
  const hasGroups = services.some(
    (service) => (service.topology?.components.length ?? 0) > 1,
  );
  const rows = services.flatMap((service) => {
    const components = service.topology?.components ?? [];
    return [
      { service, component: undefined },
      ...(components.length > 1 && expanded.has(service.id)
        ? componentLayout(service).components.map((component) => ({
            service,
            component,
          }))
        : []),
    ];
  });
  function openService(
    service: Service,
    trigger: HTMLElement,
    component?: string,
  ) {
    if (onOpen) onOpen(service, trigger, component);
    else if (component) setSelected({ service, trigger, component });
    else
      void navigate({
        to: "/services/$serviceId",
        params: { serviceId: service.id },
      });
  }
  return (
    <>
      <Table
        variant={variant}
        className="whitespace-nowrap [&_td]:px-3 [&_td]:py-2 [&_th]:px-3"
      >
        <caption className="sr-only">
          Services and their latest resource usage
        </caption>
        <TableHeader>
          <TableRow>
            {[
              "Service",
              ...(machines ? ["Machine"] : []),
              "Status",
              "CPU",
              "Memory",
              "Uptime",
              ...(machines ? [] : ["Port"]),
              ...(hasGroups ? [""] : []),
            ].map((label, i) => (
              <TableHead key={label || i} scope="col">
                {label || (
                  <span className="sr-only">Expand service components</span>
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ service: s, component }) => {
            const grouped =
              !component && (s.topology?.components.length ?? 0) > 1;
            const primary = primaryComponent(s);
            const isPrimary = component?.name === primary?.name;
            const componentName =
              component && !isPrimary ? component.name : undefined;
            const label = component
              ? isPrimary
                ? s.name
                : componentLabel(component, s)
              : grouped
                ? (s.presentation?.groupName ?? s.name)
                : s.name;
            const machineName =
              machines?.find((machine) => machine.id === s.machineId)?.name ??
              "Unknown machine";
            const source =
              component?.image ??
              (grouped
                ? `${s.topology?.components.length} components`
                : s.source.type === "github"
                  ? s.source.repository
                  : s.spec.image);
            const status = component
              ? componentStatus(s, component.name)
              : serviceStatus(s, data);
            const totalMetrics = currentMetrics(s);
            const metrics = component
              ? componentMetrics(s, component.name)
              : totalMetrics;
            const memoryLimit =
              totalMetrics?.memoryLimitBytes ?? s.spec.memoryMb * 1024 ** 2;
            return (
              <TableRow
                key={component ? `${s.id}/${component.name}` : s.id}
                className={
                  component ? "cursor-pointer bg-muted/10" : "cursor-pointer"
                }
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a,button")) return;
                  openService(
                    s,
                    e.currentTarget.querySelector<HTMLElement>(
                      "[data-service-open]",
                    ) ?? e.currentTarget,
                    componentName,
                  );
                }}
              >
                <TableHead scope="row" className="h-auto py-2 text-foreground">
                  <div
                    className={`flex items-center gap-2 ${component ? "pl-9" : ""}`}
                  >
                    <span
                      className="flex size-7 shrink-0 items-center justify-center text-muted-foreground"
                      aria-hidden="true"
                    >
                      <ServiceIcon
                        source={
                          component && !isPrimary ? { type: "image" } : s.source
                        }
                        image={component?.image ?? s.spec.image}
                        size={16}
                      />
                    </span>
                    <div
                      className="min-w-0"
                      title={source ? `${label} · ${source}` : label}
                    >
                      {component ? (
                        <button
                          type="button"
                          data-service-open
                          aria-haspopup={
                            onOpen || !isPrimary ? "dialog" : undefined
                          }
                          aria-label={`Open ${s.name} / ${label}`}
                          onClick={(event) =>
                            openService(s, event.currentTarget, componentName)
                          }
                          className="block max-w-40 truncate rounded-sm text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:max-w-56"
                        >
                          {label}
                        </button>
                      ) : (
                        <Link
                          data-service-open
                          to="/services/$serviceId"
                          params={{ serviceId: s.id }}
                          aria-haspopup={onOpen ? "dialog" : undefined}
                          onClick={(event) => {
                            if (
                              onOpen &&
                              !event.metaKey &&
                              !event.ctrlKey &&
                              !event.shiftKey &&
                              !event.altKey
                            ) {
                              event.preventDefault();
                              onOpen(s, event.currentTarget);
                            }
                          }}
                          className="block max-w-40 truncate rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:max-w-56"
                        >
                          {label}
                        </Link>
                      )}
                    </div>
                  </div>
                </TableHead>
                {machines && (
                  <TableCell className="text-muted-foreground">
                    <span
                      className=" max-w-32 truncate flex flex-row items-center gap-1"
                      title={machineName}
                    >
                      <CubeIcon />
                      {machineName}
                    </span>
                  </TableCell>
                )}
                <TableCell>
                  <ServiceStatus status={status} />
                </TableCell>
                <TableCell>
                  <Usage
                    label="CPU"
                    size="sm"
                    percent={metrics?.cpuPercent ?? null}
                    detail="Share of whole machine"
                  />
                </TableCell>
                <TableCell>
                  <Usage
                    label="Memory"
                    size="sm"
                    percent={
                      metrics && memoryLimit > 0
                        ? Math.min(
                            100,
                            (metrics.memoryBytes / memoryLimit) * 100,
                          )
                        : null
                    }
                    detail={
                      metrics
                        ? `${bytes(metrics.memoryBytes)} / ${bytes(memoryLimit)} ${component || grouped ? "template memory limit" : "container limit"}`
                        : "Unavailable"
                    }
                  />
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {metrics ? uptime(metrics.uptimeSeconds) : "—"}
                </TableCell>
                {!machines && (
                  <TableCell
                    className="font-mono text-xs"
                    title="Application port inside its container"
                  >
                    :{component?.port ?? s.spec.port}
                  </TableCell>
                )}
                {hasGroups && (
                  <TableCell className="w-12 text-right">
                    {grouped && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${expanded.has(s.id) ? "Collapse" : "Expand"} ${label} components`}
                        aria-expanded={expanded.has(s.id)}
                        onClick={() =>
                          setExpanded((previous) => {
                            const next = new Set(previous);
                            if (next.has(s.id)) next.delete(s.id);
                            else next.add(s.id);
                            return next;
                          })
                        }
                      >
                        <CaretRightIcon
                          aria-hidden="true"
                          className={
                            expanded.has(s.id) ? "rotate-90" : undefined
                          }
                        />
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {!services.length && (
            <TableRow>
              <TableCell
                colSpan={hasGroups ? 7 : 6}
                className="h-40 text-center text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {selected && (
        <ServiceDrawer
          key={`${selected.service.id}:${selected.component ?? "app"}`}
          service={selected.service}
          trigger={selected.trigger}
          component={selected.component}
          onApp={() => setSelected({ ...selected, component: undefined })}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
