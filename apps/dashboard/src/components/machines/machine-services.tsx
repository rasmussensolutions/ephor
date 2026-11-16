import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { MachineServicesMap } from "@/components/machines/machine-services-map";
import {
  type DeploymentMode,
  DeployServiceDialog,
  deploymentSources,
} from "@/components/services/deploy-service-dialog";
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
import { mergeServiceRefresh } from "@/lib/map-position-state";
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canvas = useRef<HTMLDivElement>(null);
  const [deploy, setDeploy] = useState<{
    mode: DeploymentMode | null;
    trigger: HTMLElement | null;
  } | null>(null);
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
    async function load() {
      const request = ++generation;
      if (!document.hidden) {
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
  }, []);
  const services =
    data?.services.filter((service) => service.machineId === id) ?? [];
  return (
    <section className="space-y-5">
      {view === "table" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">
            Services on this machine{data ? ` · ${services.length}` : ""}
          </h2>
          <Button
            variant="gradient"
            size="action"
            disabled={!data}
            onClick={(event) =>
              setDeploy({ mode: null, trigger: event.currentTarget })
            }
          >
            <PlusIcon
              aria-hidden="true"
              data-icon="inline-start"
              className="size-[1em]"
            />
            Deploy service
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {error ? "Services are unavailable." : "Loading services…"}
        </p>
      ) : view === "canvas" ? (
        <ContextMenu>
          <div className="relative">
            <ContextMenuTrigger render={<div />} ref={canvas}>
              <MachineServicesMap
                key={id}
                services={services}
                data={data}
                onOpen={(service, trigger, component, section) =>
                  setSelected({ service, trigger, component, section })
                }
              />
            </ContextMenuTrigger>
            <Button
              size="sm"
              variant="outline"
              className="absolute top-4 right-4 shadow-sm"
              onClick={(event) =>
                setDeploy({ mode: null, trigger: event.currentTarget })
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
                  setDeploy({
                    mode,
                    trigger: canvas.current?.querySelector("section") ?? null,
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
          services={[...services].sort((a, b) => a.name.localeCompare(b.name))}
          data={data}
          onOpen={(service, trigger, component) =>
            setSelected({ service, trigger, component })
          }
        />
      )}
      {deploy && data && (
        <DeployServiceDialog
          machineId={id}
          workers={data.workers}
          initialMode={deploy.mode}
          trigger={deploy.trigger}
          onClose={() => setDeploy(null)}
          onSaved={async (serviceId, message) => {
            setNotice(message);
            setDeploy(null);
            window.dispatchEvent(new Event("ephor:services-changed"));
            await navigate({
              to: "/services/$serviceId",
              params: { serviceId },
              search: { deploymentNotice: message },
            });
          }}
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
