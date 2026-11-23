import type { MachineList } from "@ephor/api/machines";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CatalogForm } from "@/components/services/catalog-form";
import { ServiceForm } from "@/components/services/service-form";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/auth";
import { deploymentSearch, deploymentSources } from "@/lib/deployment-sources";
import type { Project } from "@/lib/projects";
import type { ServiceList } from "@/lib/services";

export const Route = createFileRoute("/_authenticated/services_/new")({
  validateSearch: deploymentSearch,
  loaderDeps: ({ search: { projectId } }) => ({ projectId }),
  loader: async ({ deps: { projectId } }) => {
    const [inventory, data, project] = await Promise.all([
      api<MachineList>("/machines"),
      api<ServiceList>("/services?summary=1"),
      projectId
        ? api<Project>(`/projects/${encodeURIComponent(projectId)}`)
        : Promise.resolve(null),
    ]);
    return { machines: inventory.machines, workers: data.workers, project };
  },
  head: () => ({ meta: [{ title: "Deploy service — Ephor" }] }),
  errorComponent: ({ error, reset }) => (
    <div className="space-y-4">
      <Link to="/services" className="text-sm underline">
        Back to services
      </Link>
      <h1 className="page-title">Deployment unavailable</h1>
      <p role="alert" className="text-sm text-muted-foreground">
        {error instanceof Error
          ? error.message
          : "Could not load deployment options."}
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  ),
  component: DeployPage,
});

function DeployPage() {
  const { source = "github", machineId, projectId } = Route.useSearch();
  const { machines, workers, project } = Route.useLoaderData();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const machine = machines.find(
    (item) => item.id === machineId && item.status !== "revoked",
  );
  const context = project?.name ?? machine?.name;
  async function onSaved(id: string, message: string) {
    if (projectId) {
      try {
        await api(`/projects/${encodeURIComponent(projectId)}/add`, {
          serviceId: id,
        });
      } catch {
        message +=
          " Could not add the service to this project. Use Add service in the project to retry.";
      }
    }
    window.dispatchEvent(new Event("ephor:services-changed"));
    await navigate({
      to: "/services/$serviceId",
      params: { serviceId: id },
      search: { deploymentNotice: message },
    });
  }
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <header className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 gap-2 text-muted-foreground"
          disabled={busy}
          onClick={() =>
            void (projectId
              ? navigate({ to: "/projects/$projectId", params: { projectId } })
              : machineId
                ? navigate({
                    to: "/machines/$machineId",
                    params: { machineId },
                  })
                : navigate({ to: "/services" }))
          }
        >
          <ArrowLeftIcon />
          {project
            ? `Back to ${project.name}`
            : machine
              ? `Back to ${machine.name}`
              : "Back to services"}
        </Button>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Deploy service
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {context
              ? `Deploy a new service to ${context}.`
              : "Deploy an application on your own infrastructure."}
          </p>
        </div>
      </header>
      {machineId && !machine ? (
        <p
          role="alert"
          className="rounded-lg border bg-card p-4 text-sm text-destructive"
        >
          This machine is no longer available for deployments.
        </p>
      ) : (
        <>
          <nav
            aria-label="Deployment source"
            className="grid grid-cols-2 gap-1 rounded-xl border bg-muted/50 p-1 sm:grid-cols-4"
          >
            {deploymentSources.map(({ mode, label, icon: Icon }) => (
              <Button
                key={mode}
                variant="ghost"
                type="button"
                aria-pressed={source === mode}
                disabled={busy}
                className={`h-10 min-w-0 justify-center gap-2 px-2 text-xs sm:text-sm ${source === mode ? "bg-card text-foreground ring-1 ring-border shadow-xs hover:bg-card" : "text-muted-foreground"}`}
                onClick={() =>
                  void navigate({
                    to: "/services/new",
                    search: { source: mode, machineId, projectId },
                    replace: true,
                    resetScroll: false,
                  })
                }
              >
                <Icon aria-hidden="true" />
                <span className="truncate">{label}</span>
              </Button>
            ))}
          </nav>
          {source === "catalog" || source === "database" ? (
            <section className="space-y-5" key={source}>
              <h2 className="text-xl font-semibold tracking-tight">
                {source === "database"
                  ? "Deploy a database"
                  : "Deploy a template"}
              </h2>
              <CatalogForm
                machines={machines}
                workers={workers}
                initialMachineId={machineId}
                databasesOnly={source === "database"}
                onBusyChange={setBusy}
                onSaved={onSaved}
              />
            </section>
          ) : (
            <ServiceForm
              key={source}
              service={null}
              machines={machines}
              initialMachineId={machineId}
              initialSourceType={source}
              fixedSource
              className="space-y-6"
              onBusyChange={setBusy}
              onSaved={onSaved}
            />
          )}
        </>
      )}
    </div>
  );
}
