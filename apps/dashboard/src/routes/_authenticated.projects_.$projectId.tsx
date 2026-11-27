import type { MachineList } from "@ephor/api/machines";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { MachineServicesMap } from "@/components/machines/machine-services-map";
import {
  prefetchDeployment,
  useDeploymentDialog,
} from "@/components/services/deployment-provider";
import { ServiceDrawer } from "@/components/services/service-drawer";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useApiQuery } from "@/hooks/use-api-query";
import { useServices } from "@/hooks/use-services";
import { api } from "@/lib/auth";
import { deploymentSources } from "@/lib/deployment-sources";
import type { Project } from "@/lib/projects";
import type { Service, ServiceList } from "@/lib/services";

export const Route = createFileRoute("/_authenticated/projects_/$projectId")({
  loader: async ({ params }) => {
    const [project, data, machines] = await Promise.all([
      api<Project>(`/projects/${params.projectId}`),
      api<ServiceList>("/services?summary=1"),
      api<MachineList>("/machines"),
    ]);
    return { project, data, machines };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.project.name ?? "Project"} — Ephor` }],
  }),
  errorComponent: ({ error, reset }) => (
    <div className="space-y-4">
      <Link to="/projects">Back to projects</Link>
      <p role="alert">
        {error instanceof Error ? error.message : "Could not load project."}
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  ),
  component: ProjectRoute,
});
function ProjectRoute() {
  const initial = Route.useLoaderData();
  return <ProjectPage key={initial.project.id} initial={initial} />;
}
function ProjectPage({
  initial,
}: {
  initial: {
    project: Project;
    data: ServiceList;
    machines: MachineList;
  };
}) {
  const navigate = useNavigate();
  const openDeployment = useDeploymentDialog();
  const { data, machines, error: refreshError, refresh } = useServices(initial);
  const projectQuery = useApiQuery(
    `/projects/${encodeURIComponent(initial.project.id)}`,
    initial.project,
  );
  const project = projectQuery.data;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{
    service: Service;
    trigger: HTMLElement;
    component?: string;
    section?: "Domains" | "Storage";
  } | null>(null);
  const members = data.services.filter((s) =>
    project.serviceIds.includes(s.id),
  );
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await Promise.all([
        projectQuery.refetch({ throwOnError: true, cancelRefetch: false }),
        refresh(),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  function openAdd() {
    openDeployment({ projectId: project.id });
  }
  function openSettings() {
    setName(project.name);
    setSettingsOpen(true);
  }
  return (
    <div className="relative h-full min-w-0 overflow-hidden">
      <ContextMenu>
        <ContextMenuTrigger render={<div className="h-full" />}>
          <MachineServicesMap
            fullPage
            machines={machines}
            services={members}
            data={data}
            onOpen={(service, trigger, component, section) =>
              setSelected({ service, trigger, component, section })
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-56 p-2">
          <ContextMenuItem
            onClick={() =>
              openDeployment({ projectId: project.id, source: "existing" })
            }
          >
            Add existing service
          </ContextMenuItem>
          <p className="px-2 pt-3 pb-1.5 text-xs text-muted-foreground">
            Deploy new service
          </p>
          {deploymentSources.map(({ mode, label, icon: Icon }) => (
            <ContextMenuItem
              key={mode}
              className="gap-3 px-2 py-2"
              onMouseEnter={() =>
                prefetchDeployment({ projectId: project.id, source: mode })
              }
              onFocus={() =>
                prefetchDeployment({ projectId: project.id, source: mode })
              }
              onClick={() =>
                openDeployment({ projectId: project.id, source: mode })
              }
            >
              <Icon aria-hidden="true" />
              {label}
            </ContextMenuItem>
          ))}
          <ContextMenuItem onClick={openSettings}>
            Project settings
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void navigate({ to: "/projects" })}>
            Back to projects
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <header className="pointer-events-none absolute top-4 right-4">
        <h1 className="sr-only">{project.name}</h1>
        <fieldset
          aria-label="Project actions"
          className="pointer-events-auto flex"
        >
          <Button
            variant="gradient"
            size="action"
            aria-haspopup="dialog"
            className="rounded-r-none focus-visible:z-10"
            onMouseEnter={() => prefetchDeployment({ projectId: project.id })}
            onFocus={() => prefetchDeployment({ projectId: project.id })}
            onClick={openAdd}
          >
            Add service
          </Button>
          <Button
            variant="gradient"
            size="icon-lg"
            aria-haspopup="dialog"
            aria-label="Project settings"
            title="Project settings"
            className="rounded-l-none focus-visible:z-10"
            onClick={openSettings}
          >
            <GearSixIcon aria-hidden="true" />
          </Button>
        </fieldset>
      </header>
      {(refreshError || projectQuery.isError || (error && !settingsOpen)) && (
        <div className="absolute top-16 right-4 left-4 max-w-lg rounded-xl border bg-card p-3 shadow-sm">
          <p role="alert" className="text-sm text-destructive">
            {refreshError || projectQuery.error?.message || error}
          </p>
        </div>
      )}
      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setSettingsOpen(false);
            setError("");
          }
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription>
              Manage this project and its service membership.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <form
              className="flex items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => api(`/projects/${project.id}/rename`, { name }));
              }}
            >
              <label
                htmlFor="project-name"
                className="grid flex-1 gap-2 text-sm"
              >
                Project name
                <Input
                  id="project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                />
              </label>
              <Button type="submit" disabled={busy || !name.trim()}>
                Save
              </Button>
            </form>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Services</h3>
              {members.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate">{s.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(`/projects/${project.id}/remove`, {
                          serviceId: s.id,
                        }),
                      )
                    }
                  >
                    Remove from project
                  </Button>
                </div>
              ))}
            </div>
            <div className="space-y-3 border-t pt-4">
              <p className="text-sm text-muted-foreground">
                Deleting the project removes its grouping. Services continue
                running and remain available in Services.
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api(`/projects/${project.id}/delete`, {});
                    await navigate({ to: "/projects" });
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Could not delete project.",
                    );
                    setBusy(false);
                  }
                }}
              >
                Delete project
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
      {selected && (
        <ServiceDrawer
          key={`${selected.service.id}:${selected.component ?? "app"}`}
          service={selected.service}
          trigger={selected.trigger}
          component={selected.component}
          initialSection={selected.section}
          onApp={() =>
            setSelected({
              service: selected.service,
              trigger: selected.trigger,
            })
          }
          onClose={() => {
            setSelected(null);
            void run(async () => {});
          }}
        />
      )}
    </div>
  );
}
