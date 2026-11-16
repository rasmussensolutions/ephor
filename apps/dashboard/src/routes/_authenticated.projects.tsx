import type { MachineList } from "@ephor/api/machines";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
    <div className="space-y-6">
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
      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <h2 className="font-medium">Create your first project</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Bring an app, its database, and other services together.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => {
            const services = data.services.filter((s) =>
              project.serviceIds.includes(s.id),
            );
            const machineIds = new Set(services.map((s) => s.machineId));
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
              <Link
                key={project.id}
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className="space-y-4 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/40"
              >
                <h2 className="truncate font-medium">{project.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {services.length} services · {machineIds.size} machines
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {machines.machines
                    .filter((m) => machineIds.has(m.id))
                    .map((m) => m.name)
                    .join(", ") || "Add services to get started"}
                </p>
                {problems > 0 && (
                  <p className="text-sm text-destructive">
                    {problems} services need attention
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
