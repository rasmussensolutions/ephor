import type { MachineList } from "@ephor/api/machines";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { ServiceSummaryCards } from "@/components/services/service-summary-cards";
import { ServicesTable } from "@/components/services/services-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useServices } from "@/hooks/use-services";
import { api } from "@/lib/auth";
import {
  currentMetrics,
  type ServiceList,
  serviceNeedsAttention,
  serviceStatus,
} from "@/lib/services";
export const Route = createFileRoute("/_authenticated/services")({
  validateSearch: (search: Record<string, unknown>): { deploy?: boolean } => ({
    deploy:
      search.deploy === true || search.deploy === "true" ? true : undefined,
  }),
  beforeLoad: ({ location, search }) => {
    // Existing GitHub Apps may still have /services registered as their callback.
    if (new URLSearchParams(location.searchStr).has("github"))
      throw redirect({ href: `/settings/integrations${location.searchStr}` });
    if (search.deploy) throw redirect({ to: "/services/new", replace: true });
  },
  head: () => ({ meta: [{ title: "Services — Ephor" }] }),
  loader: async () => {
    const [data, machines] = await Promise.all([
      api<ServiceList>("/services?summary=1"),
      api<MachineList>("/machines"),
    ]);
    return { data, machines };
  },
  component: ServicesPage,
});
function ServicesPage() {
  const { data, machines, error } = useServices(Route.useLoaderData());
  const [filter, setFilter] = useState("All"),
    [search, setSearch] = useState(""),
    [machine, setMachine] = useState("all"),
    [sort, setSort] = useState("name");
  const rows = data.services.map((service) => ({
    service,
    status: serviceStatus(service, data),
    metrics: currentMetrics(service),
  }));
  const matches = (status: string, group: string) =>
    group === "All" ||
    (group === "Running"
      ? status === "Running"
      : group === "Stopped"
        ? ["Stopped", "Not deployed"].includes(status)
        : serviceNeedsAttention(status));
  const visible = rows
    .filter(
      (r) =>
        matches(r.status, filter) &&
        (machine === "all" || r.service.machineId === machine) &&
        `${r.service.name} ${r.service.domain ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "cpu"
        ? (b.metrics?.cpuPercent ?? -1) - (a.metrics?.cpuPercent ?? -1)
        : sort === "memory"
          ? (b.metrics?.memoryBytes ?? -1) - (a.metrics?.memoryBytes ?? -1)
          : a.service.name.localeCompare(b.service.name),
    );
  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Services</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your applications, their health, and resources at a glance.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="gradient"
            size="action"
            render={<Link to="/services/new" />}
          >
            <PlusIcon
              aria-hidden="true"
              data-icon="inline-start"
              className="size-[1em]"
            />
            Deploy service
          </Button>
        </div>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ServiceSummaryCards
        rows={rows}
        machines={machines}
        problemsFiltered={filter === "Problems"}
        onToggleProblems={() =>
          setFilter((current) => (current === "Problems" ? "All" : "Problems"))
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {["All", "Running", "Stopped", "Problems"].map((group) => (
            <button
              key={group}
              type="button"
              aria-pressed={filter === group}
              onClick={() => setFilter(group)}
              className={`rounded-md px-3 py-1.5 text-sm ${filter === group ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {group}{" "}
              <span className="ml-1 tabular-nums text-muted-foreground">
                {rows.filter((r) => matches(r.status, group)).length}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            variant="toolbar"
            className="w-56"
            aria-label="Search services"
            placeholder="Search services…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            aria-label="Filter by machine"
            value={machine}
            onValueChange={(next) => setMachine(next)}
            options={[
              { value: "all", label: "All machines" },
              ...machines.map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
          <Select
            aria-label="Sort services"
            value={sort}
            onValueChange={(next) => setSort(next)}
            options={[
              { value: "name", label: "Name" },
              { value: "cpu", label: "CPU usage" },
              { value: "memory", label: "Memory usage" },
            ]}
          />
        </div>
      </div>
      <ServicesTable
        variant="layered"
        services={visible.map((row) => row.service)}
        data={data}
        machines={machines}
        emptyMessage={
          data.services.length
            ? "No services match your filters."
            : "Deploy your first service to get started."
        }
      />
    </div>
  );
}
