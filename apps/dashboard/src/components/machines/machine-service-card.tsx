import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { Link } from "@tanstack/react-router";
import { ServiceIcon } from "@/components/services/service-icon";
import { ServiceStatus } from "@/components/services/service-status";
import type { Project } from "@/lib/projects";
import {
  currentMetrics,
  type Service,
  type ServiceList,
  serviceStatus,
} from "@/lib/services";
import { ServiceCardUsage } from "./service-card-usage";
import { ServiceProjectBadge } from "./service-project-badge";

export function MachineServiceCard({
  service,
  data,
  project,
  onOpen,
}: {
  service: Service;
  data: ServiceList;
  project?: Project;
  onOpen?: (service: Service, trigger: HTMLElement) => void;
}) {
  const metrics = currentMetrics(service);
  return (
    <Link
      to="/services/$serviceId"
      params={{ serviceId: service.id }}
      draggable={false}
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
          onOpen(service, event.currentTarget);
        }
      }}
      className="group flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground transition-colors hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <ServiceIcon
              source={service.source}
              image={service.spec.image}
              size={21}
            />
          </span>
          <div className="min-w-0 flex-1">
            <h3
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={service.name}
            >
              {service.name}
            </h3>
            <p
              className="truncate text-sm text-muted-foreground"
              title={service.domain ?? service.spec.image ?? undefined}
            >
              {service.domain ?? service.spec.image ?? "No public domain"}
            </p>
          </div>
          {onOpen ? (
            <SidebarSimpleIcon
              aria-hidden
              className="shrink-0 text-muted-foreground"
            />
          ) : (
            <ArrowUpRightIcon
              aria-hidden
              className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
            />
          )}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <ServiceStatus status={serviceStatus(service, data)} />
          <ServiceProjectBadge project={project} />
        </div>
      </div>
      <ServiceCardUsage metrics={metrics} />
    </Link>
  );
}
