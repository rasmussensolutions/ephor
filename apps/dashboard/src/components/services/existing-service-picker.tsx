import type { MachineList } from "@ephor/api/machines";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, request } from "@/lib/auth";
import type { Project, ProjectList } from "@/lib/projects";
import { apiKey, queryClient } from "@/lib/query";
import type { Service } from "@/lib/services";

export function ExistingServicePicker({
  projectId,
  services,
  machines,
  onBusyChange,
  onAdded,
}: {
  projectId: string;
  services: Service[];
  machines: MachineList["machines"];
  onBusyChange: (busy: boolean) => void;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState("");
  const projects = useQuery({
    queryKey: apiKey("/projects"),
    queryFn: ({ signal }) =>
      request<ProjectList>("/projects", undefined, signal),
  });
  const assigned = new Set(
    projects.data?.projects.flatMap((p) => p.serviceIds),
  );
  const available = services.filter((service) => !assigned.has(service.id));
  const term = search.trim().toLowerCase();
  const matches = available.filter((service) =>
    service.name.toLowerCase().includes(term),
  );

  async function add(serviceId: string) {
    setAdding(serviceId);
    setError("");
    onBusyChange(true);
    const path = `/projects/${encodeURIComponent(projectId)}`;
    try {
      await api(`${path}/add`, { serviceId });
      queryClient().setQueryData<Project>(apiKey(path), (project) =>
        project && !project.serviceIds.includes(serviceId)
          ? { ...project, serviceIds: [...project.serviceIds, serviceId] }
          : project,
      );
      onAdded();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not add service.",
      );
      void projects.refetch();
    } finally {
      onBusyChange(false);
      setAdding(null);
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 pb-5">
      <div className="relative w-full min-w-0 shrink-0">
        <MagnifyingGlassIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          variant="toolbar"
          aria-label="Search services"
          placeholder="Search services…"
          className="block h-9 pl-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {projects.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading existing services…
          </p>
        ) : projects.isError && !projects.data ? (
          <>
            <p role="alert" className="text-sm text-destructive">
              {projects.error.message}
            </p>
            <Button variant="raised" onClick={() => void projects.refetch()}>
              Try again
            </Button>
          </>
        ) : matches.length ? (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {matches.map((service) => (
              <li
                key={service.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p
                    className="truncate text-sm font-medium"
                    title={service.name}
                  >
                    {service.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {
                      machines.find(
                        (machine) => machine.id === service.machineId,
                      )?.name
                    }
                  </p>
                </div>
                <Button
                  variant="raised"
                  size="sm"
                  disabled={adding !== null}
                  aria-label={`Add ${service.name} to project`}
                  onClick={() => void add(service.id)}
                >
                  {adding === service.id ? "Adding…" : "Add"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {available.length
              ? "No services match your search."
              : "No unassigned services are available."}
          </p>
        )}
      </div>
    </div>
  );
}
