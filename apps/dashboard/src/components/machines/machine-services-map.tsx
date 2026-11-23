import { ArrowsOutSimpleIcon } from "@phosphor-icons/react/dist/csr/ArrowsOutSimple";
import { MagicWandIcon } from "@phosphor-icons/react/dist/csr/MagicWand";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { Link } from "@tanstack/react-router";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MachineServiceCard } from "@/components/machines/machine-service-card";
import { Button } from "@/components/ui/button";
import { useMapPositions } from "@/hooks/use-map-positions";
import { mapGridSize } from "@/lib/map-grid";
import type { Project } from "@/lib/projects";
import { type MapPoint, mapLayout, projectMapLayout } from "@/lib/service-map";
import { autoLayoutServices } from "@/lib/service-map-auto-layout";
import { serviceMapConnections } from "@/lib/service-map-connector";
import type { Service, ServiceList } from "@/lib/services";
import { MapDraggable } from "./map-draggable";
import { TemplateServiceGroup } from "./template-service-group";

const minZoom = 0.25;
const maxZoom = 1.5;
const canvasOrigin = { x: 320, y: 240 };

function centerViewport(element: HTMLElement) {
  element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
  element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
}

export function MachineServicesMap({
  services,
  data,
  onOpen,
  fullPage = false,
  machines,
  projects = [],
  autoLayoutDisabled = false,
}: {
  fullPage?: boolean;
  autoLayoutDisabled?: boolean;
  machines?: { id: string; name: string }[];
  projects?: Project[];
  services: Service[];
  data: ServiceList;
  onOpen: (
    service: Service,
    trigger: HTMLElement,
    component?: string,
    section?: "Domains",
  ) => void;
}) {
  const viewport = useRef<HTMLElement>(null);
  const pan = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const pendingZoom = useRef<{ scale: number; scroll?: MapPoint } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [autoLayoutVersion, setAutoLayoutVersion] = useState(0);
  const [autoLayoutError, setAutoLayoutError] = useState("");
  const hasServices = services.length > 0;
  const positions = useMapPositions(services);
  const serviceProjects = new Map(
    projects.flatMap((project) =>
      project.serviceIds.map((id) => [id, project] as const),
    ),
  );
  const layout = machines
    ? projectMapLayout(positions.services, machines)
    : { ...mapLayout(positions.services), groups: [] };
  const { groups } = layout;
  function localPoint(service: Service, point: MapPoint) {
    const group = groups.find((item) => item.id === service.machineId);
    return group
      ? { x: Math.max(0, point.x - group.x), y: Math.max(0, point.y - 48) }
      : point;
  }
  // Shrinking scroll bounds during a drag can clamp the viewport and move cards
  // under the pointer. Keep the canvas extent stable for this map session.
  const extent = useRef({ width: 0, height: 0 });
  extent.current.width = Math.max(extent.current.width, layout.width);
  extent.current.height = Math.max(extent.current.height, layout.height);
  const { nodes } = layout;
  const connections = serviceMapConnections(nodes);
  const { width, height } = extent.current;
  const gridSpacing = mapGridSize * zoom;
  const dotScale = Math.min(1, zoom);
  const dotRadius = Math.max(0.55, 1.1 * dotScale);

  useLayoutEffect(() => {
    const element = viewport.current;
    const pending = pendingZoom.current;
    if (pending && pending.scale !== zoom) return;
    pendingZoom.current = null;
    if (!element || !hasServices) return;
    if (pending?.scroll) {
      element.scrollLeft = pending.scroll.x;
      element.scrollTop = pending.scroll.y;
    } else {
      centerViewport(element);
    }
  }, [zoom, hasServices]);

  function changeZoom(value: number, anchor?: MapPoint | null) {
    const element = viewport.current;
    if (!element) return;
    const next = Math.max(minZoom, Math.min(maxZoom, value));
    if (next === zoom) {
      if (anchor === null) centerViewport(element);
      if (pendingZoom.current) {
        pendingZoom.current = null;
        setZoom(next);
      }
      return;
    }
    pendingZoom.current = { scale: next };
    if (anchor !== null) {
      // Pinches anchor at the pointer. Buttons anchor at the viewport center.
      const x = element.scrollLeft + (anchor?.x ?? element.clientWidth / 2);
      const y = element.scrollTop + (anchor?.y ?? element.clientHeight / 2);
      const scaleChange = next / zoom - 1;
      pendingZoom.current.scroll = {
        x: element.scrollLeft + (x - canvasOrigin.x) * scaleChange,
        y: element.scrollTop + (y - canvasOrigin.y) * scaleChange,
      };
    }
    setZoom(next);
  }

  function fitServices() {
    const element = viewport.current;
    if (!element) return;
    const scale = Math.max(
      minZoom,
      Math.min(
        1,
        element.clientWidth / layout.width,
        element.clientHeight / layout.height,
      ),
    );
    const scroll = {
      x: canvasOrigin.x + (layout.width * scale - element.clientWidth) / 2,
      y: canvasOrigin.y + (layout.height * scale - element.clientHeight) / 2,
    };
    if (scale === zoom) {
      pendingZoom.current = null;
      element.scrollLeft = scroll.x;
      element.scrollTop = scroll.y;
    } else {
      pendingZoom.current = { scale, scroll };
      setZoom(scale);
    }
  }

  function autoLayout() {
    try {
      const updates = autoLayoutServices(positions.services, projects);
      // Explicit arranging may shrink the canvas; dragging must not do so.
      extent.current = { width: 0, height: 0 };
      positions.commitMany(updates);
      setAutoLayoutError("");
      setAutoLayoutVersion((version) => version + 1);
    } catch {
      setAutoLayoutError(
        "Could not arrange these services. Move widely spread components closer together and try again.",
      );
    }
  }

  const fitAfterAutoLayout = useEffectEvent(fitServices);
  useLayoutEffect(() => {
    if (autoLayoutVersion > 0) fitAfterAutoLayout();
  }, [autoLayoutVersion]);

  const pinchZoom = useEffectEvent(
    (event: WheelEvent, element: HTMLElement) => {
      if (!hasServices || !event.ctrlKey) return;
      const mode = event.deltaMode;
      const delta = event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const unit =
        mode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : mode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientHeight
            : 1;
      const current = pendingZoom.current?.scale ?? zoom;
      changeZoom(current * Math.exp((-delta * unit) / 300), {
        x: event.clientX - bounds.left - element.clientLeft,
        y: event.clientY - bounds.top - element.clientTop,
      });
    },
  );
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    // Desktop browsers send a Ctrl-wheel event for trackpad pinches.
    const onWheel = (event: WheelEvent) => pinchZoom(event, element);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className={
        fullPage
          ? "relative h-full overflow-hidden bg-background"
          : "relative overflow-hidden rounded-xl border bg-background"
      }
    >
      <section
        ref={viewport}
        aria-label="Service map"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable map must support keyboard panning.
        tabIndex={0}
        className={`${fullPage ? "h-full" : "h-[clamp(420px,58vh,680px)]"} cursor-grab overflow-auto overscroll-contain outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing [&::-webkit-scrollbar]:hidden`}
        onPointerDown={(event) => {
          // Touch uses native scrolling; links keep their normal interaction.
          if (
            event.pointerType === "touch" ||
            event.button !== 0 ||
            (event.target as HTMLElement).closest("a, button")
          )
            return;
          const element = event.currentTarget;
          pan.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          };
          element.setPointerCapture(event.pointerId);
          element.focus({ preventScroll: true });
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const start = pan.current;
          if (!start || start.id !== event.pointerId) return;
          event.currentTarget.scrollLeft =
            start.left - (event.clientX - start.x);
          event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          pan.current = null;
        }}
        onPointerCancel={() => {
          pan.current = null;
        }}
        onLostPointerCapture={() => {
          pan.current = null;
        }}
      >
        <div
          className="relative flex min-h-full min-w-full items-center justify-center"
          style={{
            minWidth: services.length
              ? `calc(100% + ${canvasOrigin.x * 2}px)`
              : undefined,
            minHeight: services.length
              ? `calc(100% + ${canvasOrigin.y * 2}px)`
              : undefined,
            width: services.length ? width * zoom + canvasOrigin.x * 2 : "100%",
            height: services.length
              ? height * zoom + canvasOrigin.y * 2
              : "100%",
            backgroundImage: `radial-gradient(circle, color-mix(in oklch, var(--muted-foreground) ${23 * dotScale}%, transparent) ${dotRadius * 0.55}px, transparent ${dotRadius}px)`,
            backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
            backgroundPosition: `${canvasOrigin.x - gridSpacing / 2}px ${canvasOrigin.y - gridSpacing / 2}px`,
          }}
        >
          {services.length ? (
            <div
              className="absolute"
              style={{
                left: canvasOrigin.x,
                top: canvasOrigin.y,
                width: width * zoom,
                height: height * zoom,
              }}
            >
              <div
                className="relative origin-top-left"
                style={{
                  width,
                  height,
                  transform: `scale(${zoom})`,
                }}
              >
                {groups.map((group) => (
                  <div
                    key={group.id}
                    className="pointer-events-none absolute rounded-2xl border border-border/60 bg-muted/10"
                    style={{
                      left: group.x,
                      top: 0,
                      width: group.width,
                      height: group.height,
                    }}
                  >
                    <Link
                      to="/machines/$machineId"
                      params={{ machineId: group.id }}
                      className="pointer-events-auto absolute top-4 left-5 text-sm font-medium text-muted-foreground hover:text-foreground"
                    >
                      {group.name}
                    </Link>
                  </div>
                ))}
                {connections.length > 0 && (
                  <svg
                    role="img"
                    aria-label="Saved service connections"
                    className="pointer-events-none absolute inset-0 size-full overflow-visible text-muted-foreground/60"
                  >
                    <title>
                      Saved service connections. Deploy changes to apply them.
                    </title>
                    {connections.map((connection) => (
                      <g key={connection.key}>
                        <title>{connection.label}</title>
                        <path
                          d={connection.path}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.25"
                          strokeDasharray="5 5"
                        />
                        <path
                          d={connection.arrow}
                          fill="currentColor"
                          opacity="0.7"
                        />
                      </g>
                    ))}
                  </svg>
                )}
                {nodes.map(({ service, x, y, width, height }) => (
                  <MapDraggable
                    key={service.id}
                    point={{ x, y }}
                    zoom={zoom}
                    label={`Move ${service.name}${(service.topology?.components.length ?? 0) > 1 ? " group" : " card"}`}
                    handleOnly={(service.topology?.components.length ?? 0) > 1}
                    onMove={(point) =>
                      positions.move(service.id, "", localPoint(service, point))
                    }
                    onCommit={(point) =>
                      positions.commit(
                        service.id,
                        "",
                        localPoint(service, point),
                      )
                    }
                    onCancel={() => positions.cancel(service.id, "")}
                    style={{ width, height }}
                  >
                    {service.topology?.components.length ? (
                      <TemplateServiceGroup
                        service={service}
                        data={data}
                        project={serviceProjects.get(service.id)}
                        onOpen={onOpen}
                        zoom={zoom}
                        onCancel={(component) =>
                          positions.cancel(service.id, component)
                        }
                        onMove={(component, point) =>
                          positions.move(service.id, component, point)
                        }
                        onCommit={(component, point) =>
                          positions.commit(service.id, component, point)
                        }
                      />
                    ) : (
                      <MachineServiceCard
                        service={service}
                        data={data}
                        project={serviceProjects.get(service.id)}
                        onOpen={onOpen}
                      />
                    )}
                  </MapDraggable>
                ))}
              </div>
            </div>
          ) : (
            <div className="m-6 max-w-sm rounded-xl border bg-card p-8 text-center">
              <h3 className="font-medium">Your services will appear here</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {machines
                  ? "Add an existing service or right-click to deploy something new."
                  : "Create a service and choose this machine to deploy your first workload."}
              </p>
            </div>
          )}
        </div>
      </section>
      {(autoLayoutError || (positions.error && !positions.saving)) && (
        <div className="absolute bottom-4 left-4 flex max-w-sm items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-destructive shadow-sm">
          <p role="alert">{autoLayoutError || "Layout not saved."}</p>
          {!autoLayoutError && (
            <button
              type="button"
              onClick={positions.retry}
              className="underline underline-offset-4"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {hasServices && (
        <fieldset
          aria-label="Map controls"
          className="absolute right-4 bottom-4 flex items-center gap-1 rounded-lg border bg-card p-1 shadow-sm"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom <= minZoom}
            onClick={() => changeZoom(zoom - 0.25)}
          >
            <MinusIcon />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-14 tabular-nums"
            aria-label="Reset zoom to 100%"
            title="Reset zoom"
            onClick={() => changeZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= maxZoom}
            onClick={() => changeZoom(zoom + 0.25)}
          >
            <PlusIcon />
          </Button>
          <span aria-hidden className="mx-1 h-4 border-l" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fit all services"
            title="Fit all services"
            onClick={fitServices}
          >
            <ArrowsOutSimpleIcon />
          </Button>
          <span aria-hidden className="mx-1 h-4 border-l" />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Auto-layout services"
            title={
              positions.error
                ? "Retry failed layout saves before arranging"
                : autoLayoutDisabled
                  ? "Waiting for current project information"
                  : "Arrange cards by project and save their positions"
            }
            disabled={
              autoLayoutDisabled || positions.saving > 0 || positions.error
            }
            onClick={autoLayout}
          >
            <MagicWandIcon aria-hidden="true" />
            Auto layout
          </Button>
        </fieldset>
      )}
    </div>
  );
}
