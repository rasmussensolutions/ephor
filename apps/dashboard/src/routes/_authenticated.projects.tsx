import type { MachineList } from "@ephor/api/machines";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { StatusIndicator } from "@/components/status-indicator";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/auth";
import type { Project, ProjectList } from "@/lib/projects";
import { type ServiceList, serviceStatus } from "@/lib/services";

export const Route = createFileRoute("/_authenticated/projects")({
  loader: async () => {
    const [projects, data, machines] = await Promise.all([
      api<ProjectList>("/projects"),
      api<ServiceList>("/services?summary=1"),
      api<MachineList>("/machines"),
    ]);
    return { ...projects, data, machines };
  },
  head: () => ({ meta: [{ title: "Projects — Ephor" }] }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { projects, data, machines } = Route.useLoaderData();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="min-w-0 space-y-6">
      <Dialog
        open={creating}
        onOpenChange={(open, details) => {
          if (!open && busy) {
            details.cancel();
            return;
          }
          setCreating(open);
          setError("");
        }}
      >
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="page-title">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your applications and the services they use.
            </p>
          </div>
          <DialogTrigger render={<Button variant="gradient" size="action" />}>
            New project
          </DialogTrigger>
        </header>
        <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <form
              className="space-y-4"
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || !name.trim()) return;
                setBusy(true);
                setError("");
                try {
                  const project = await api<Project>("/projects/create", {
                    name,
                  });
                  await navigate({
                    to: "/projects/$projectId",
                    params: { projectId: project.id },
                  });
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not create project.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label htmlFor="new-project-name" className="grid gap-2 text-sm">
                Project name
                <Input
                  id="new-project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={80}
                  placeholder="Storefront"
                  readOnly={busy}
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setCreating(false);
                    setError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="gradient"
                  size="action"
                  disabled={busy || !name.trim()}
                >
                  {busy ? "Creating…" : "Create project"}
                </Button>
              </div>
            </form>
          </DialogBody>
        </DialogContent>
      </Dialog>
      <Table variant="layered" className="[&_td]:px-3 [&_td]:py-3 [&_th]:px-3">
        <caption className="sr-only">
          Projects, their services, machines, and status
        </caption>
        <TableHeader>
          <TableRow>
            {["Project", "Services", "Machines", "Status"].map((title) => (
              <TableHead key={title} scope="col">
                {title}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => {
            const services = data.services.filter((s) =>
              project.serviceIds.includes(s.id),
            );
            const machineIds = new Set(services.map((s) => s.machineId));
            const projectMachines = Array.from(machineIds, (id) => ({
              id,
              name:
                machines.machines.find((machine) => machine.id === id)?.name ??
                "Unknown machine",
            }));
            const [firstMachine] = projectMachines;
            const problems = services.filter((s) =>
              [
                "Failed",
                "Unhealthy",
                "Unavailable",
                "Stopped",
                "Missing",
                "Recovery required",
              ].includes(serviceStatus(s, data)),
            ).length;
            return (
              <TableRow
                key={project.id}
                className="cursor-pointer"
                onClick={(event) => {
                  if (
                    event.defaultPrevented ||
                    !(event.target instanceof Element) ||
                    !event.currentTarget.contains(event.target) ||
                    event.target.closest("a,button") ||
                    window.getSelection()?.isCollapsed === false
                  )
                    return;
                  const link =
                    event.currentTarget.querySelector<HTMLAnchorElement>("a");
                  if (!link) return;
                  if (event.metaKey || event.ctrlKey || event.shiftKey) {
                    window.open(link.href, "_blank", "noopener,noreferrer");
                  } else {
                    link.click();
                  }
                }}
              >
                <TableHead scope="row" className="py-3 text-foreground">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    className="flex items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FolderOpenIcon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span
                      className="block min-w-0 max-w-64 truncate text-sm font-medium"
                      title={project.name}
                    >
                      {project.name}
                    </span>
                  </Link>
                </TableHead>
                <TableCell className="tabular-nums text-muted-foreground">
                  {services.length}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {projectMachines.length > 1 ? (
                    <Popover>
                      <PopoverTrigger
                        aria-label={`Show ${projectMachines.length} machines for ${project.name}`}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-sm whitespace-nowrap tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {projectMachines.length} machines
                        <CaretDownIcon
                          aria-hidden="true"
                          className="size-3.5"
                        />
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        aria-label={`Machines for ${project.name}`}
                        className="min-w-48 p-1.5"
                      >
                        <ul className="space-y-1">
                          {projectMachines.map((machine) => (
                            <li key={machine.id}>
                              <Link
                                to="/machines/$machineId"
                                params={{ machineId: machine.id }}
                                title={machine.name}
                                className="block max-w-64 truncate rounded-md px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {machine.name}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </PopoverContent>
                    </Popover>
                  ) : firstMachine ? (
                    <Link
                      to="/machines/$machineId"
                      params={{ machineId: firstMachine.id }}
                      title={firstMachine.name}
                      className="block max-w-64 truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {firstMachine.name}
                    </Link>
                  ) : (
                    <span className="tabular-nums">0</span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusIndicator
                    tone={problems > 0 ? "error" : "neutral"}
                    status={
                      problems > 0
                        ? `${problems} ${problems === 1 ? "service needs" : "services need"} attention`
                        : services.length
                          ? "No issues"
                          : "No services"
                    }
                  />
                </TableCell>
              </TableRow>
            );
          })}
          {projects.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="h-40 text-center">
                <h2 className="font-medium">Create your first project</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Bring an app, its database, and other services together.
                </p>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
