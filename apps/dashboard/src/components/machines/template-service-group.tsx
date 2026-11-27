import { ServiceIcon } from "@/components/services/service-icon";
import { ServiceStatus } from "@/components/services/service-status";
import { groupGridOffset } from "@/lib/map-grid";
import type { Project } from "@/lib/projects";
import {
  componentHeight,
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
import { serviceStorage } from "@/lib/service-storage";
import {
  bytes,
  currentMetrics,
  type Service,
  type ServiceList,
  serviceStatus,
} from "@/lib/services";
import { MapDraggable } from "./map-draggable";
import { ServiceCardFrame, serviceCardActionClass } from "./service-card-frame";
import { ServiceCardStorage } from "./service-card-storage";
import { ServiceCardSummary } from "./service-card-summary";
import { ServiceCardUsage } from "./service-card-usage";
import { ServiceGroupEditor } from "./service-group-editor";
import { ServiceProjectBadge } from "./service-project-badge";

export function TemplateServiceGroup({
  service,
  data,
  project,
  machineName,
  onOpen,
  zoom,
  onMove,
  onCommit,
  onCancel,
}: {
  service: Service;
  data: ServiceList;
  project?: Project;
  machineName?: string;
  zoom: number;
  onMove: (component: string, point: MapPoint) => void;
  onCommit: (component: string, point: MapPoint) => void;
  onCancel: (component: string) => void;
  onOpen: (
    service: Service,
    trigger: HTMLElement,
    component?: string,
    section?: "Domains" | "Storage",
  ) => void;
}) {
  const topology = service.topology,
    primary = primaryComponent(service);
  if (!topology || !primary) return null;
  const layout = componentLayout(service);
  const { components } = layout;
  const grouped = components.length > 1;
  const groupName = service.presentation?.groupName ?? service.name;
  const groupColorKey = service.presentation?.groupColor ?? "neutral";
  const groupColor = groupPalette[groupColorKey].color;
  const accent = `color-mix(in oklab, ${groupColor} 48%, black)`;
  const lightHeader =
    groupColorKey === "neutral"
      ? "color-mix(in oklab, var(--background) 90%, transparent)"
      : `oklch(from ${groupColor} 0.875 calc(c * 0.65) h / 94%)`;
  const lightBody =
    groupColorKey === "neutral"
      ? "color-mix(in oklab, var(--card) 85%, transparent)"
      : `oklch(from ${groupColor} 0.966 calc(c * 0.18) h / 98%)`;
  const lightBorder =
    groupColorKey === "neutral"
      ? "color-mix(in oklab, var(--border) 90%, var(--card))"
      : `color-mix(in oklab, var(--border) 76%, ${groupColor})`;
  const total = currentMetrics(service);
  const appStatus = serviceStatus(service, data);
  const position = (name: string) => layout.positions[name] ?? { x: 0, y: 0 };
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Multi-component wrappers have an accessible group role; standalone cards have no group role or label.
    <div
      role={grouped ? "group" : undefined}
      aria-label={grouped ? `${groupName} service group` : undefined}
      className={
        grouped
          ? "relative h-full overflow-hidden rounded-2xl border backdrop-blur-[5px]"
          : "h-full"
      }
      style={
        grouped
          ? {
              backgroundColor: `light-dark(
                ${lightHeader},
                color-mix(in oklab, var(--background) 55%, ${accent} 9%)
              )`,
              borderColor: `light-dark(
                ${lightBorder},
                color-mix(in oklab, ${accent} 30%, var(--border))
              )`,
            }
          : undefined
      }
    >
      {grouped && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-14 bottom-0 rounded-t-xl"
          style={{
            backgroundColor: `light-dark(
              ${lightBody},
              color-mix(in oklab, color-mix(in oklab, var(--card), var(--background) 38%) 61%, ${accent} 9%)
            )`,
            boxShadow: `0 0 0 1px light-dark(
              ${lightBorder},
              color-mix(in oklab, ${accent} 16%, var(--border))
            )`,
          }}
        />
      )}
      {grouped && (
        <div className="flex h-14 items-center gap-3 px-6 [&:not(.dark_*)]:[--muted-foreground:oklch(0.43_0_0)]">
          <button
            type="button"
            data-map-handle
            aria-label={`Move ${groupName} group`}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-3 text-left active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <ServiceIcon
              source={service.source}
              image={primary.image}
              size={20}
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
          marginRight: grouped ? 24 + layout.leftInset : undefined,
        }}
      >
        {grouped && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 size-full overflow-visible text-muted-foreground/60"
          >
            {topology.dependencies.map((edge) => {
              const connector = mapConnector(
                {
                  ...position(edge.from),
                  height: componentHeight(service, edge.from),
                },
                {
                  ...position(edge.to),
                  height: componentHeight(service, edge.to),
                },
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
          const height = componentHeight(service, component.name);
          const card = (
            <ServiceCardFrame
              key={component.name}
              name={label}
              icon={
                <ServiceIcon
                  source={isPrimary ? service.source : { type: "image" }}
                  image={component.image}
                  size={16}
                />
              }
              action={
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={
                    isPrimary ? service.name : `${service.name} / ${label}`
                  }
                  title={label}
                  onClick={(event) =>
                    onOpen(
                      service,
                      event.currentTarget,
                      isPrimary ? undefined : component.name,
                    )
                  }
                  className={`absolute inset-0 ${serviceCardActionClass}`}
                />
              }
              footer={
                <ServiceCardStorage
                  volumes={serviceStorage(service, component.name)}
                  onOpen={(trigger) =>
                    onOpen(service, trigger, component.name, "Storage")
                  }
                />
              }
            >
              <ServiceCardSummary
                status={componentStatus(service, component.name)}
                machineName={machineName}
                project={grouped ? undefined : project}
                domain={
                  isPrimary && primaryHasDomains(service)
                    ? service.domain
                    : undefined
                }
              />
              <ServiceCardUsage metrics={usage} />
            </ServiceCardFrame>
          );
          return grouped ? (
            <MapDraggable
              key={component.name}
              point={point}
              gridOffset={groupGridOffset}
              zoom={zoom}
              label={`Move ${label}`}
              style={{ width: 264, height }}
              onMove={(next) => onMove(component.name, next)}
              onCommit={(next) => onCommit(component.name, next)}
              onCancel={() => onCancel(component.name)}
            >
              {card}
            </MapDraggable>
          ) : (
            <div key={component.name} style={{ width: 264, height }}>
              {card}
            </div>
          );
        })}
      </div>
    </div>
  );
}
