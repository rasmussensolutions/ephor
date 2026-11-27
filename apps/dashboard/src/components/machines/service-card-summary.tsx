import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { ServiceStatus } from "@/components/services/service-status";
import type { Project } from "@/lib/projects";
import { ServiceMachineLabel } from "./service-machine-label";
import { ServiceProjectBadge } from "./service-project-badge";

export function ServiceCardSummary({
  status,
  machineName,
  project,
  domain,
}: {
  status: string;
  machineName?: string;
  project?: Project;
  domain?: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-1.5 px-3 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2 px-2">
        <ServiceStatus status={status} />
        <ServiceProjectBadge project={project} />
      </div>
      <div
        className="flex min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground"
        title={domain ?? "No public domain configured"}
      >
        <GlobeIcon aria-hidden size={14} className="shrink-0" />
        <span className="truncate">{domain || "Private"}</span>
      </div>
      <ServiceMachineLabel name={machineName} />
    </div>
  );
}
