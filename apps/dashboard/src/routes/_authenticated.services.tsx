import type { MachineList } from "@ephor/api/machines";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CatalogForm } from "@/components/services/catalog-form";
import { ServiceForm } from "@/components/services/service-form";
import { ServiceSummaryCards } from "@/components/services/service-summary-cards";
import { ServicesTable } from "@/components/services/services-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  beforeLoad: ({ location }) => {
    // Existing GitHub Apps may still have /services registered as their callback.
    if (new URLSearchParams(location.searchStr).has("github"))
      throw redirect({ href: `/settings/integrations${location.searchStr}` });
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
  const { deploy } = Route.useSearch();
  const { data, machines, error } = useServices(Route.useLoaderData());
  const navigate = useNavigate();
  const [deployMode, setDeployMode] = useState("catalog");
  const [deployBusy, setDeployBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!deploy) return;
    setOpen(true);
    void navigate({ to: "/services", search: {}, replace: true });
  }, [deploy, navigate]);
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
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && deployBusy) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <div className="min-w-0 space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="page-title">Services</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your applications, their health, and resources at a glance.
            </p>
          </div>
          <div className="flex gap-2">
            <DialogTrigger render={<Button variant="gradient" size="action" />}>
              <PlusIcon
                aria-hidden="true"
                data-icon="inline-start"
                className="size-[1em]"
              />
              Deploy service
            </DialogTrigger>
          </div>
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        <ServiceSummaryCards
          rows={rows}
          machines={machines}
          problemsFiltered={filter === "Problems"}
          onToggleProblems={() =>
            setFilter((current) =>
              current === "Problems" ? "All" : "Problems",
            )
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
          services={visible.map((row) => row.service)}
          data={data}
          machines={machines}
          emptyMessage={
            data.services.length
              ? "No services match your filters."
              : "Deploy your first service to get started."
          }
        />
        <DialogContent
          className="h-[40rem] [&>[data-slot=dialog-surface]]:flex-1"
          showCloseButton={!deployBusy}
        >
          <DialogHeader>
            <DialogTitle>Deploy service</DialogTitle>
            <DialogDescription>
              Choose an app from the catalog, connect a repository, or use an
              image.
            </DialogDescription>
          </DialogHeader>
          <div className="shrink-0 px-5 pb-5 sm:px-6">
            <div className="flex gap-2 rounded-lg bg-muted p-1">
              {["catalog", "custom"].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={deployBusy}
                  aria-pressed={deployMode === mode}
                  onClick={() => setDeployMode(mode)}
                  className={`flex-1 rounded-md px-3 py-2 text-sm ${deployMode === mode ? "bg-card" : "text-muted-foreground"}`}
                >
                  {mode === "catalog" ? "App catalog" : "Repository or image"}
                </button>
              ))}
            </div>
          </div>
          <DialogBody key={deployMode} className="[scrollbar-gutter:stable]">
            {deployMode === "catalog" ? (
              <CatalogForm
                machines={machines}
                workers={data.workers}
                onBusyChange={setDeployBusy}
                onSaved={async (id, message) => {
                  setNotice(message);
                  await navigate({
                    to: "/services/$serviceId",
                    params: { serviceId: id },
                    search: { deploymentNotice: message },
                  });
                  setOpen(false);
                }}
              />
            ) : (
              <ServiceForm
                key={String(open)}
                className="space-y-5"
                onBusyChange={setDeployBusy}
                service={null}
                machines={machines}
                onSaved={async (id, message) => {
                  setNotice(message);
                  await navigate({
                    to: "/services/$serviceId",
                    params: { serviceId: id },
                    search: { deploymentNotice: message },
                  });
                  setOpen(false);
                }}
              />
            )}
          </DialogBody>
        </DialogContent>
      </div>
    </Dialog>
  );
}
