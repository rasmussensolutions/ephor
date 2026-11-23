import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { ServiceIcon } from "@/components/services/service-icon";
import { ServiceStatus } from "@/components/services/service-status";
import { groupGridOffset } from "@/lib/map-grid";
import type { Project } from "@/lib/projects";
import {
  componentCardHeight,
  componentLabel,
  componentLayout,
  componentMetrics,
  componentStatus,
  type MapPoint,
  primaryComponent,
  primaryHasDomains,
} from "@/lib/service-map";
import { mapConnector } from "@/lib/service-map-connector";
import { groupPalette } from "@/lib/service-presentation";
import {
  bytes,
  currentMetrics,
  type Service,
  type ServiceList,
  serviceStatus,
} from "@/lib/services";
import { MapDraggable } from "./map-draggable";
import { ServiceCardUsage } from "./service-card-usage";
import { ServiceGroupEditor } from "./service-group-editor";
import { ServiceProjectBadge } from "./service-project-badge";

export function TemplateServiceGroup({
  service,
  data,
  project,
  onOpen,
  zoom,
  onMove,
  onCommit,
  onCancel,
}: {
  service: Service;
  data: ServiceList;
  project?: Project;
  zoom: number;
  onMove: (component: string, point: MapPoint) => void;
  onCommit: (component: string, point: MapPoint) => void;
  onCancel: (component: string) => void;
  onOpen: (
    service: Service,
    trigger: HTMLElement,
    component?: string,
    section?: "Domains",
  ) => void;
}) {
  const topology = service.topology,
    primary = primaryComponent(service);
  if (!topology || !primary) return null;
  const layout = componentLayout(service);
  const { components } = layout;
  const grouped = components.length > 1;
  const groupName = service.presentation?.groupName ?? service.name;
  const accent =
    groupPalette[service.presentation?.groupColor ?? "neutral"].color;
  const total = currentMetrics(service);
  const appStatus = serviceStatus(service, data);
  const position = (name: string) => layout.positions[name] ?? { x: 0, y: 0 };
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Multi-component wrappers have an accessible group role; standalone cards have no group role or label.
    <div
      role={grouped ? "group" : undefined}
      aria-label={grouped ? `${groupName} service group` : undefined}
      className={grouped ? "h-full rounded-2xl border" : "h-full"}
      style={
        grouped
          ? {
              borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`,
              backgroundColor: `color-mix(in srgb, ${accent} 6%, transparent)`,
            }
          : undefined
      }
    >
      {grouped && (
        <div className="flex h-14 items-center gap-3 px-6">
          <button
            type="button"
            data-map-handle
            aria-label={`Move ${groupName} group`}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-3 text-left active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <SquaresFourIcon
              size={20}
              style={{ color: accent }}
              className="shrink-0"
            />
            <span className="truncate text-sm font-medium" title={groupName}>
              {groupName}
            </span>
          </button>
          <ServiceProjectBadge project={project} />
          <span className="text-[11px] text-muted-foreground">
            {appStatus !== "Running" ? (
              <ServiceStatus status={appStatus} />
            ) : total ? (
              `${bytes(total.memoryBytes)} total`
            ) : (
              `${components.length} components`
            )}
          </span>
          <div data-map-no-drag>
            <ServiceGroupEditor service={service} />
          </div>
        </div>
      )}
      <div
        className={grouped ? "relative mx-6 mt-1" : "relative"}
        style={{
          height: layout.height,
        }}
      >
        {grouped && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 size-full overflow-visible text-muted-foreground/60"
          >
            {topology.dependencies.map((edge) => {
              const connector = mapConnector(
                position(edge.from),
                position(edge.to),
              );
              if (!connector) return null;
              return (
                <g key={`${edge.from}-${edge.to}`}>
                  <path
                    d={connector.path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeDasharray="5 5"
                  />
                  <path d={connector.arrow} fill="currentColor" opacity="0.7" />
                </g>
              );
            })}
          </svg>
        )}
        {components.map((component) => {
          const point = position(component.name),
            usage = componentMetrics(service, component.name),
            isPrimary = component.name === primary.name;
          const label = isPrimary
            ? service.name
            : componentLabel(component, service);
          const dependencies = topology.dependencies.filter(
            (d) => d.from === component.name,
          );
          const card = (
            <div
              key={component.name}
              style={{ width: 264, height: componentCardHeight }}
              className="relative flex flex-col overflow-hidden rounded-xl border bg-card"
            >
              <button
                type="button"
                aria-haspopup="dialog"
                aria-label={
                  isPrimary ? service.name : `${service.name} / ${label}`
                }
                onClick={(e) =>
                  onOpen(
                    service,
                    e.currentTarget,
                    isPrimary ? undefined : component.name,
                  )
                }
                className="absolute inset-0 cursor-grab rounded-xl active:cursor-grabbing hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
              <div className="pointer-events-none relative flex min-h-0 flex-1 flex-col gap-4 px-4 py-4">
                <span className="flex w-full items-center gap-3">
                  <ServiceIcon
                    source={isPrimary ? service.source : { type: "image" }}
                    image={component.image}
                    size={23}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-sm font-medium"
                      title={label}
                    >
                      {label}
                    </span>
                    {isPrimary && primaryHasDomains(service) && (
                      <button
                        type="button"
                        data-map-no-drag
                        aria-label={`Domain setup for ${service.name}`}
                        title={service.domain ?? "Set up domain"}
                        onClick={(e) =>
                          onOpen(service, e.currentTarget, undefined, "Domains")
                        }
                        className="pointer-events-auto block w-full truncate text-left text-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {service.domain ?? "Set up domain"}
                      </button>
                    )}
                  </span>
                </span>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <ServiceStatus
                    status={componentStatus(service, component.name)}
                  />
                  {!grouped && <ServiceProjectBadge project={project} />}
                </div>
              </div>
              {!(isPrimary && primaryHasDomains(service)) && (
                <span
                  className="pointer-events-none relative flex h-8 shrink-0 items-center truncate border-t px-4 text-[11px] text-muted-foreground"
                  title={dependencies
                    .map((d) => `${d.variables.join(", ")} → ${d.to}`)
                    .join("; ")}
                >
                  {dependencies.length
                    ? `Uses ${dependencies.map((d) => componentLabel(topology.components.find((c) => c.name === d.to) ?? { name: d.to, image: "" }, service)).join(", ")}`
                    : `Private · Port ${component.port}`}
                </span>
              )}
              <ServiceCardUsage metrics={usage} />
            </div>
          );
          return grouped ? (
            <MapDraggable
              key={component.name}
              point={point}
              gridOffset={groupGridOffset}
              zoom={zoom}
              label={`Move ${label}`}
              style={{ width: 264, height: componentCardHeight }}
              onMove={(next) => onMove(component.name, next)}
              onCommit={(next) => onCommit(component.name, next)}
              onCancel={() => onCancel(component.name)}
            >
              {card}
            </MapDraggable>
          ) : (
            <div key={component.name}>{card}</div>
          );
        })}
      </div>
    </div>
  );
}
