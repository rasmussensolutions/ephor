import { Link } from "@tanstack/react-router";
import { ServiceIcon } from "@/components/services/service-icon";
import type { Project } from "@/lib/projects";
import { serviceStorage } from "@/lib/service-storage";
import {
  currentMetrics,
  type Service,
  type ServiceList,
  serviceStatus,
} from "@/lib/services";
import { ServiceCardFrame, serviceCardActionClass } from "./service-card-frame";
import { ServiceCardStorage } from "./service-card-storage";
import { ServiceCardSummary } from "./service-card-summary";
import { ServiceCardUsage } from "./service-card-usage";

export function MachineServiceCard({
  service,
  data,
  project,
  machineName,
  onOpen,
}: {
  service: Service;
  data: ServiceList;
  project?: Project;
  machineName?: string;
  onOpen: (
    service: Service,
    trigger: HTMLElement,
    component?: string,
    section?: "Domains" | "Storage",
  ) => void;
}) {
  const metrics = currentMetrics(service);
  return (
    <ServiceCardFrame
      name={service.name}
      icon={
        <ServiceIcon
          source={service.source}
          image={service.spec.image}
          size={16}
        />
      }
      renderMain={(content) => (
        <Link
          to="/services/$serviceId"
          params={{ serviceId: service.id }}
          draggable={false}
          aria-haspopup="dialog"
          onClick={(event) => {
            if (
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              onOpen(service, event.currentTarget);
            }
          }}
          className={`flex min-h-0 flex-1 flex-col ${serviceCardActionClass}`}
        >
          {content}
        </Link>
      )}
      footer={
        <ServiceCardStorage
          volumes={serviceStorage(service)}
          onOpen={(trigger) => onOpen(service, trigger, undefined, "Storage")}
        />
      }
    >
      <ServiceCardSummary
        status={serviceStatus(service, data)}
        machineName={machineName}
        project={project}
        domain={service.domain}
      />
      <ServiceCardUsage metrics={metrics} />
    </ServiceCardFrame>
  );
}
