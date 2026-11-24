import type { MachineList } from "@ephor/api/machines";
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
import { useServices } from "@/hooks/use-services";
import { api } from "@/lib/auth";
import { deploymentSources } from "@/lib/deployment-sources";
import type { Project, ProjectList } from "@/lib/projects";
import type { Service, ServiceList } from "@/lib/services";

export const Route = createFileRoute("/_authenticated/projects_/$projectId")({
  loader: async ({ params }) => {
    const [project, inventory, data, machines] = await Promise.all([
      api<Project>(`/projects/${params.projectId}`),
      api<ProjectList>("/projects"),
      api<ServiceList>("/services?summary=1"),
      api<MachineList>("/machines"),
    ]);
    return { project, inventory, data, machines };
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
    inventory: ProjectList;
    data: ServiceList;
    machines: MachineList;
  };
}) {
  const navigate = useNavigate();
  const openDeployment = useDeploymentDialog();
  const { data, machines, error: refreshError, refresh } = useServices(initial);
  const [project, setProject] = useState(initial.project);
  const [inventory, setInventory] = useState(initial.inventory);
  const [dialog, setDialog] = useState<"add" | "settings" | null>(null);
  const [name, setName] = useState(project.name);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{
    service: Service;
    trigger: HTMLElement;
    component?: string;
    section?: "Domains";
  } | null>(null);
  const members = data.services.filter((s) =>
    project.serviceIds.includes(s.id),
  );
  const assigned = new Set(inventory.projects.flatMap((p) => p.serviceIds));
  const available = data.services.filter(
    (s) =>
      !assigned.has(s.id) &&
      s.name.toLowerCase().includes(search.toLowerCase()),
  );
  async function reload() {
    const [next, list] = await Promise.all([
      api<Project>(`/projects/${project.id}`),
      api<ProjectList>("/projects"),
      refresh(),
    ]);
    setProject(next);
    setInventory(list);
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  function openAdd() {
    setDialog("add");
    void run(async () => {});
  }
  function openSettings() {
    setName(project.name);
    setDialog("settings");
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
          <ContextMenuItem onClick={() => openAdd()}>
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
      <header className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-4 pl-16 md:pl-4">
        <div className="pointer-events-auto flex min-w-0 max-w-full items-center gap-3 rounded-xl border bg-card/95 px-4 py-2.5 shadow-sm backdrop-blur-sm">
          <Link
            to="/projects"
            className="shrink-0 text-sm text-muted-foreground hover:text-foreground"
            aria-label="Back to projects"
          >
            ← Projects
          </Link>
          <span aria-hidden="true" className="h-5 border-l" />
          <h1 className="truncate text-sm font-medium">{project.name}</h1>
          <span className="text-xs text-muted-foreground">Production</span>
        </div>
        <div className="pointer-events-auto flex gap-2 rounded-xl border bg-card/95 p-1.5 shadow-sm backdrop-blur-sm">
          <Button variant="ghost" size="sm" onClick={openSettings}>
            Settings
          </Button>
          <Button size="sm" onClick={() => openAdd()}>
            Add service
          </Button>
        </div>
      </header>
      {(refreshError || (error && !dialog)) && (
        <div className="absolute top-32 left-4 right-4 max-w-lg rounded-xl border bg-card p-3 shadow-sm sm:top-20">
          {(refreshError || (error && !dialog)) && (
            <p role="alert" className="text-sm text-destructive">
              {refreshError || error}
            </p>
          )}
        </div>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDialog(null);
            setError("");
          }
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {dialog === "add" ? "Add service" : "Project settings"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "add"
                ? "Add an existing service or deploy a new one into this project."
                : "Manage this project and its service membership."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {dialog === "add" ? (
              <>
                <label
                  htmlFor="project-service-search"
                  className="grid gap-2 text-sm"
                >
                  Existing services
                  <Input
                    id="project-service-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search services"
                  />
                </label>
                <div className="max-h-56 space-y-2 overflow-auto">
                  {available.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {machines.find((m) => m.id === s.machineId)?.name}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api(`/projects/${project.id}/add`, {
                              serviceId: s.id,
                            }),
                          )
                        }
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                  {available.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No unassigned services match.
                    </p>
                  )}
                </div>
                <div className="space-y-3 border-t pt-4">
                  <Button
                    disabled={busy}
                    onMouseEnter={() =>
                      prefetchDeployment({ projectId: project.id })
                    }
                    onFocus={() =>
                      prefetchDeployment({ projectId: project.id })
                    }
                    onClick={() => {
                      setDialog(null);
                      openDeployment({ projectId: project.id });
                    }}
                  >
                    Deploy new service
                  </Button>
                </div>
              </>
            ) : (
              <>
                <form
                  className="flex items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(() =>
                      api(`/projects/${project.id}/rename`, { name }),
                    );
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
              </>
            )}
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
