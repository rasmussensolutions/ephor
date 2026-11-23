import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MachineServicesMap } from "@/components/machines/machine-services-map";
import { ServiceDrawer } from "@/components/services/service-drawer";
import { ServicesTable } from "@/components/services/services-table";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { api } from "@/lib/auth";
import { deploymentSources } from "@/lib/deployment-sources";
import { mergeServiceRefresh } from "@/lib/map-position-state";
import type { Project, ProjectList } from "@/lib/projects";
import { applyPresentation } from "@/lib/service-presentation";
import type { Service, ServiceList } from "@/lib/services";

export function MachineServices({
  id,
  view,
}: {
  id: string;
  view: "table" | "canvas";
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<ServiceList | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectError, setProjectError] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{
    service: Service;
    trigger: HTMLElement;
    component?: string;
    section?: "Domains";
  } | null>(null);
  useEffect(() => {
    const changed = (event: Event) =>
      setData((previous) =>
        previous ? applyPresentation(previous, event) : previous,
      );
    window.addEventListener("ephor:service-presentation", changed);
    return () =>
      window.removeEventListener("ephor:service-presentation", changed);
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let generation = 0;
    async function loadProjects(request: number) {
      if (view !== "canvas") return;
      try {
        const next = await api<ProjectList>("/projects");
        if (active && request === generation) {
          setProjects(next.projects);
          setProjectError("");
        }
      } catch {
        if (active && request === generation)
          setProjectError(
            "Could not refresh project badges. They may be missing or out of date. Retrying automatically.",
          );
      }
    }
    async function load() {
      const request = ++generation;
      if (!document.hidden) {
        const inventory = loadProjects(request);
        try {
          const next = await api<ServiceList>("/services?summary=1");
          if (active && request === generation) {
            setData((previous) => mergeServiceRefresh(previous, next));
            setError("");
          }
        } catch {
          if (active && request === generation)
            setError(
              "Could not refresh services. Values may be out of date. Retrying automatically.",
            );
        }
        await inventory;
      }
    }
    async function poll() {
      await load();
      if (active) timer = setTimeout(poll, 15000);
    }
    const changed = () => void load();
    window.addEventListener("ephor:services-changed", changed);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("ephor:services-changed", changed);
    };
  }, [view]);
  const services =
    data?.services.filter((service) => service.machineId === id) ?? [];
  return (
    <section className="space-y-5">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {view === "canvas" && projectError && (
        <p role="alert" className="text-sm text-destructive">
          {projectError}
        </p>
      )}
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {error ? "Services are unavailable." : "Loading services…"}
        </p>
      ) : view === "canvas" ? (
        <ContextMenu>
          <div className="relative">
            <ContextMenuTrigger render={<div />}>
              <MachineServicesMap
                key={id}
                services={services}
                data={data}
                projects={projects ?? []}
                autoLayoutDisabled={projects === null || Boolean(projectError)}
                onOpen={(service, trigger, component, section) =>
                  setSelected({ service, trigger, component, section })
                }
              />
            </ContextMenuTrigger>
            <Button
              size="sm"
              variant="outline"
              className="absolute top-4 right-4 shadow-sm"
              onClick={() =>
                void navigate({
                  to: "/services/new",
                  search: { machineId: id },
                })
              }
            >
              <PlusIcon aria-hidden="true" />
              Deploy service
            </Button>
          </div>
          <ContextMenuContent className="min-w-56 p-2">
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Add service
            </p>
            {deploymentSources.map(({ mode, label, icon: Icon }) => (
              <ContextMenuItem
                key={mode}
                className="gap-3 px-2 py-2"
                onClick={() =>
                  void navigate({
                    to: "/services/new",
                    search: { machineId: id, source: mode },
                  })
                }
              >
                <Icon aria-hidden="true" />
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        <ServicesTable
          variant="layered"
          services={[...services].sort((a, b) => a.name.localeCompare(b.name))}
          data={data}
          onOpen={(service, trigger, component) =>
            setSelected({ service, trigger, component })
          }
        />
      )}
      {selected && (
        <ServiceDrawer
          key={`${selected.service.id}:${selected.component ?? "app"}`}
          component={selected.component}
          initialSection={selected.section}
          onApp={() =>
            setSelected({
              service: selected.service,
              trigger: selected.trigger,
            })
          }
          service={selected.service}
          trigger={selected.trigger}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
