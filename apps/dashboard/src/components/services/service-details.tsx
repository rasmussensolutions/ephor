import type { MachineList } from "@ephor/api/machines";

import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsThreeVertical";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { Link } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { SecurityWorkspace } from "@/components/security/security-workspace";
import { CatalogDetails } from "@/components/services/catalog-details";
import { ServiceCharts } from "@/components/services/service-charts";
import { ServiceDomains } from "@/components/services/service-domains";
import { ServiceForm } from "@/components/services/service-form";
import { ServiceIcon } from "@/components/services/service-icon";
import { ServiceStatus } from "@/components/services/service-status";
import {
  ServiceVariables,
  type VariablePending,
} from "@/components/services/service-variables";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useServices } from "@/hooks/use-services";
import { api, errorMessage, signIn } from "@/lib/auth";
import { needsFirstDeployment } from "@/lib/first-deployment";
import {
  componentLabel,
  componentLayout,
  componentMetrics,
  componentStatus,
  primaryComponent,
  primaryHasDomains,
} from "@/lib/service-map";
import {
  bytes,
  code,
  currentMetrics,
  type Service,
  type ServiceList,
  serviceStatus,
  uptime,
} from "@/lib/services";
import { ComponentDetails } from "./component-details";
import { ComponentVariables } from "./component-variables";
import { DeploymentInspector } from "./deployment-inspector";
import { DisplayNameEditor } from "./display-name-editor";
import { FirstDeployment } from "./first-deployment";
export function ServiceDetails({
  id,
  initial,
  drawer = false,
  onPendingChange,
  initialSection,
  initialNotice,
}: {
  id: string;
  initial: { data: ServiceList; machines: MachineList };
  drawer?: boolean;
  initialSection?: "Domains";
  initialNotice?: string;
  onPendingChange?: (pending: VariablePending) => void;
}) {
  const [firstDeployment] = useState(() => {
    const service = initial.data.services.find((item) => item.id === id);
    return !drawer && !!service && needsFirstDeployment(service, initial.data);
  });
  const [showFirstDeployment, setShowFirstDeployment] = useState(
    firstDeployment && !initialSection,
  );
  const {
    data,
    machines,
    error: refreshError,
    refresh,
  } = useServices(initial, id, showFirstDeployment ? 2000 : 10000);
  const service = data.services.find((item) => item.id === id);
  const [tab, setTab] = useState(
      initialSection
        ? drawer
          ? "Settings"
          : initialSection
        : drawer
          ? "Deployments"
          : "Overview",
    ),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(initialNotice ?? "");
  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(
    null,
  );
  const [selectedComponent, setSelectedComponent] = useState<string | null>(
    null,
  );
  const componentTrigger = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (selectedComponent === null && componentTrigger.current)
      document
        .getElementById(componentTrigger.current)
        ?.focus({ preventScroll: true });
  }, [selectedComponent]);
  const sections = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll the selected tab into view after a tab change or returning from a component.
  useLayoutEffect(() => {
    const nav = sections.current;
    const selected = nav?.querySelector<HTMLButtonElement>(
      'button[aria-pressed="true"]',
    );
    if (!nav || !selected) return;
    const viewport = nav.getBoundingClientRect(),
      target = selected.getBoundingClientRect();
    if (target.left < viewport.left)
      nav.scrollLeft += target.left - viewport.left;
    else if (target.right > viewport.right)
      nav.scrollLeft += target.right - viewport.right;
  }, [tab, selectedComponent]);
  const [pending, setPending] = useState<VariablePending>({
    dirty: false,
    busy: false,
  });
  const handlePending = useCallback(
    (value: VariablePending) => {
      setPending(value);
      onPendingChange?.(value);
    },
    [onPendingChange],
  );
  function canLeave() {
    return (
      !pending.busy &&
      (!pending.dirty || confirm("Discard unsaved variable changes?"))
    );
  }
  async function run(fn: () => Promise<void>, fresh = true) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (fresh) await signIn();
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function action(s: Service, kind: string, deploymentId?: string) {
    if (
      kind === "stop" &&
      !confirm(
        s.spec.catalog
          ? `Stop ${s.name} and all its components? The app and its dependencies will become unavailable.`
          : `Stop ${s.name}? Its public endpoint will become unavailable.`,
      )
    )
      return;
    if (
      kind === "deploy" &&
      (s.spec.catalog || s.spec.volumes?.length) &&
      s.currentDeployment &&
      !confirm(
        s.spec.catalog
          ? "Restart this app? Ephor takes a recovery point and restarts its pinned containers. The app will be unavailable during this operation."
          : "Deploy this app? Ephor takes a recovery point before starting the new image. The app will be unavailable during the stop/start deployment.",
      )
    )
      return;
    await run(async () => {
      await api(`/services/${s.id}/action`, { action: kind, deploymentId });
      setNotice(
        `${kind === "stop" ? "Stop" : kind === "rollback" ? "Rollback" : "Deployment"} queued.`,
      );
    });
  }
  const ready = (machineId: string, deploying = false) =>
    data.workers.some(
      (w) =>
        w.machine_id === machineId &&
        Number(w.version) >=
          (deploying && service?.requiredWorkerProtocol
            ? service.requiredWorkerProtocol
            : service?.spec.volumes?.length ||
                service?.spec.catalog?.resources ||
                service?.spec.catalog?.template === "qdrant"
              ? 6
              : deploying && service?.variableConnections?.length
                ? 5
                : service?.spec.catalog
                  ? 3
                  : 2) &&
        Number(w.last_seen) > Date.now() - 120000,
    );
  if (!service)
    return drawer ? (
      <SheetHeader>
        <SheetTitle>Service unavailable</SheetTitle>
        <SheetDescription>
          This service may have been removed. Close the drawer and refresh the
          map.
        </SheetDescription>
      </SheetHeader>
    ) : (
      <p>Service unavailable.</p>
    );
  const active = data.deployments.find(
    (d) => d.service_id === id && ["queued", "running"].includes(d.status),
  );
  const building = data.builds.some(
    (b) =>
      b.service_id === id && ["queued", "running", "built"].includes(b.status),
  );
  const primary = primaryComponent(service);
  const primaryRuntime = service.runtime?.catalog?.components.find(
    (c) => c.name === primary?.name,
  );
  const metrics = primary
      ? componentMetrics(service, primary.name)
      : currentMetrics(service),
    status = serviceStatus(service, data);
  const hasDomains = !service.spec.catalog || primaryHasDomains(service);
  const domainsTab = drawer ? "Settings" : "Domains";
  const logs = primary ? primaryRuntime?.logs : service.runtime?.logs;
  const machine = machines.find((m) => m.id === service.machineId);
  const currentDeployment = data.deployments.find(
    (deployment) => deployment.id === service.currentDeployment,
  );
  const connectionWorkerOutdated =
    Boolean(service.variableConnections?.length) &&
    !data.workers.some(
      (worker) =>
        worker.machine_id === service.machineId &&
        Number(worker.version) >=
          Math.max(5, service.requiredWorkerProtocol ?? 5),
    );
  const canStop =
    !busy && !active && ready(service.machineId) && !!service.currentDeployment;
  const canDeploy =
    !busy &&
    !pending.busy &&
    !pending.dirty &&
    !active &&
    !building &&
    ready(service.machineId, true);
  const stopLabel = service.spec.catalog ? "Stop app" : "Stop";
  const deployLabel = service.spec.catalog
    ? "Start / restart app"
    : "Deploy latest";
  const deployHint = pending.dirty
    ? "Save or discard variable changes before deploying."
    : undefined;
  const deploymentActions = (
    <div className="flex gap-2">
      <Button
        variant="outline"
        disabled={!canStop}
        onClick={() => action(service, "stop")}
      >
        {stopLabel}
      </Button>
      <Button
        disabled={!canDeploy}
        title={deployHint}
        onClick={() => action(service, "deploy")}
      >
        {deployLabel}
      </Button>
    </div>
  );
  if (drawer && selectedComponent)
    return (
      <ComponentDetails
        key={selectedComponent}
        id={id}
        name={selectedComponent}
        initial={{ data, machines: { ...initial.machines, machines } }}
        onApp={() => setSelectedComponent(null)}
      />
    );
  if (showFirstDeployment)
    return (
      <FirstDeployment
        service={service}
        data={data}
        machineName={machine?.name ?? "Unknown machine"}
        busy={busy}
        canDeploy={canDeploy}
        error={error || refreshError}
        notice={notice}
        onDeploy={() => void action(service, "deploy")}
        onOpen={(section) => {
          setTab(section);
          setShowFirstDeployment(false);
        }}
      />
    );
  return (
    <div
      className={drawer ? "flex min-h-0 flex-1 flex-col" : "min-w-0 space-y-7"}
    >
      {firstDeployment && (
        <Button
          variant="raised"
          size="action"
          onClick={() => {
            if (!canLeave()) return;
            handlePending({ dirty: false, busy: false });
            setShowFirstDeployment(true);
          }}
        >
          Back to deployment progress
        </Button>
      )}
      <header
        className={`flex flex-wrap items-start justify-between gap-4 ${drawer ? "shrink-0 px-5 py-7 pr-16 sm:px-10 sm:py-9 sm:pr-20" : ""}`}
      >
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <ServiceIcon
              source={service.source}
              image={service.spec.image}
              size={drawer ? 32 : 20}
            />
            {drawer ? (
              <SheetTitle className="min-w-0 break-words text-2xl font-semibold tracking-tight">
                {service.name}
              </SheetTitle>
            ) : (
              <h1 className="page-title">{service.name}</h1>
            )}
            <DisplayNameEditor id={service.id} name={service.name} />
            {!drawer && <ServiceStatus status={status} badge />}
          </div>
          {!drawer && (
            <p className="mt-3 text-sm text-muted-foreground">
              {service.source.type === "github"
                ? `${service.source.repository} · ${service.source.branch}`
                : service.source.type === "catalog"
                  ? primary
                    ? `Primary component · ${primary.name}`
                    : `Catalog · ${service.source.template}`
                  : "Container image"}{" "}
              · :{service.spec.port} · on {machine?.name ?? "Unknown machine"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {drawer && (
            <Link
              to="/services/$serviceId"
              params={{ serviceId: id }}
              onClick={(event) => {
                if (!canLeave()) event.preventDefault();
              }}
              aria-label="Open service page"
              title="Open service page"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowSquareOutIcon size={14} />
              <span className="sr-only">Open page</span>
            </Link>
          )}
          {!drawer && service.domain && (
            <a
              className="rounded-lg border bg-card px-3 py-2 text-sm hover:bg-accent"
              href={`https://${service.domain}`}
              target="_blank"
              rel="noreferrer"
            >
              Visit {service.domain} ↗
            </a>
          )}
        </div>
      </header>
      {drawer && (
        <SheetDescription className="sr-only">
          Service deployments, variables, metrics, logs, and configuration.
        </SheetDescription>
      )}
      {(error || refreshError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || refreshError}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 ${drawer ? "shrink-0 border-b px-5 sm:px-10" : ""}`}
      >
        <nav
          ref={sections}
          aria-label="Service sections"
          className={
            drawer
              ? "flex min-w-0 flex-1 gap-6 overflow-x-auto"
              : "flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1"
          }
        >
          {[
            ...(drawer
              ? ["Deployments", "Variables", "Metrics", "Logs", "Security"]
              : [
                  "Overview",
                  ...(hasDomains ? ["Domains"] : []),
                  "Deployments",
                  "Variables",
                  "Logs",
                  "Security",
                ]),
            ...(drawer && (service.topology?.components.length ?? 0) > 1
              ? ["Components"]
              : []),
            ...(!drawer &&
            (service.spec.catalog || service.spec.volumes?.length)
              ? ["Setup & data"]
              : ["Settings"]),
          ].map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className={`shrink-0 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${drawer ? `border-b-2 px-0 pb-4 pt-1 ${tab === t ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}` : `rounded-md px-3 py-1.5 ${tab === t ? "bg-card" : "text-muted-foreground"}`}`}
            >
              {drawer && t === "Setup & data" ? "Settings" : t}
            </button>
          ))}
        </nav>
        {!drawer && deploymentActions}
      </div>
      <div
        className={
          drawer
            ? "min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-4 sm:px-10 sm:py-5"
            : "space-y-7"
        }
      >
        {drawer && (
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
            {tab === "Deployments" &&
              !selectedDeployment &&
              status === "Running" &&
              service.domain && (
                <a
                  href={`https://${service.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 max-w-full items-center gap-2.5 text-sm hover:underline"
                >
                  <GlobeIcon
                    size={18}
                    className="shrink-0 text-emerald-600 dark:text-emerald-400"
                  />
                  <span className="truncate">{service.domain}</span>
                </a>
              )}
            <div className="ml-auto flex items-center gap-4">
              <span className="text-xs text-muted-foreground">
                {machine?.name ?? "Unknown machine"}
              </span>
              {tab !== "Deployments" && <ServiceStatus status={status} />}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Service actions"
                      className="text-muted-foreground"
                    />
                  }
                >
                  <DotsThreeVerticalIcon aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!canStop}
                    onClick={() => action(service, "stop")}
                  >
                    {stopLabel}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canDeploy}
                    title={deployHint}
                    onClick={() => action(service, "deploy")}
                  >
                    {deployLabel}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
        {!ready(service.machineId, true) && (
          <p className="text-sm text-muted-foreground">
            The deployment worker is offline or needs an update. Check
            Deployments in machine settings. Existing containers continue
            running independently.
          </p>
        )}
        {service.variablesPending && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-primary/20 bg-primary/5 p-4"
          >
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-sm font-medium">Changes need deployment</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {active || building
                  ? "Deployment is in progress. Saved variables remain pending until a deployment containing them succeeds."
                  : "Your saved variables and connections haven’t been applied to the running service."}
                {!active &&
                  !building &&
                  service.source.installationId &&
                  " Deploying rebuilds your repository and starts the app with the saved values."}
                {connectionWorkerOutdated &&
                  " Update the deployment worker in machine settings before applying service connections."}
              </p>
            </div>
            <Button
              disabled={
                busy ||
                pending.busy ||
                pending.dirty ||
                !!active ||
                building ||
                !ready(service.machineId, true)
              }
              title={
                pending.dirty
                  ? "Save or discard your draft before deploying."
                  : undefined
              }
              onClick={() => action(service, "deploy")}
            >
              {active || building
                ? "Deploying…"
                : connectionWorkerOutdated
                  ? "Update worker first"
                  : "Deploy changes"}
            </Button>
          </div>
        )}
        {!drawer && primary && tab !== "Deployments" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            <span>
              {primary.name} component ·{" "}
              <ServiceStatus status={componentStatus(service, primary.name)} />
            </span>
            <span>
              Deployments, restart and backups include{" "}
              {service.topology?.components.length === 1
                ? "this component"
                : `all ${service.topology?.components.length} components`}
              .
            </span>
          </div>
        )}
        {hasDomains && (
          <ServiceDomains
            key={JSON.stringify([
              service.domains,
              service.domain,
              machine?.telemetry?.ipAddresses,
            ])}
            service={service}
            addresses={machine?.telemetry?.ipAddresses ?? []}
            visible={tab === domainsTab}
            showNotice={tab === "Overview"}
            running={status === "Running"}
            onOpen={() => setTab(domainsTab)}
            onConfigure={service.spec.catalog ? undefined : () => setOpen(true)}
          />
        )}
        {drawer && tab === "Components" && (
          <section
            aria-label="Service components"
            className="divide-y rounded-xl border"
          >
            {componentLayout(service).components.map((component) => {
              const isPrimary = component.name === primary?.name;
              const label = isPrimary
                ? service.name
                : componentLabel(component, service);
              const usage = componentMetrics(service, component.name);
              return (
                <button
                  key={component.name}
                  id={`service-component-${id}-${component.name}`}
                  type="button"
                  onClick={(event) => {
                    if (isPrimary) setTab("Metrics");
                    else {
                      componentTrigger.current = event.currentTarget.id;
                      setSelectedComponent(component.name);
                    }
                  }}
                  className="flex w-full items-center gap-3 px-4 py-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring first:rounded-t-xl last:rounded-b-xl"
                  aria-label={`Open ${label} component`}
                >
                  <span className="shrink-0 text-muted-foreground">
                    <ServiceIcon
                      source={isPrimary ? service.source : { type: "image" }}
                      image={component.image}
                      size={24}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {label}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {isPrimary ? "Main service" : "Dependency"} · Port{" "}
                      {component.port}
                      {usage && ` · ${bytes(usage.memoryBytes)} memory`}
                    </span>
                  </span>
                  <ServiceStatus
                    status={componentStatus(service, component.name)}
                  />
                  <CaretRightIcon
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground"
                  />
                </button>
              );
            })}
          </section>
        )}
        {(tab === "Overview" || tab === "Metrics") && (
          <div className="space-y-7">
            {!drawer && primary && (
              <h2 className="text-sm font-medium">
                {service.name} usage · {primary.name} component
              </h2>
            )}
            {!metrics && (
              <p className="text-sm text-muted-foreground">
                {primary
                  ? "The worker has not reported current metrics for this component. Update the machine’s worker if component telemetry is unavailable."
                  : "No current resource report. If this service is running, update its deployment worker from machine settings to enable metrics."}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {(
                [
                  [
                    "CPU",
                    CpuIcon,
                    metrics?.cpuPercent != null
                      ? `${metrics.cpuPercent.toFixed(1)}%`
                      : "—",
                    "of the whole machine",
                  ],
                  [
                    "Memory",
                    MemoryIcon,
                    metrics ? bytes(metrics.memoryBytes) : "—",
                    metrics
                      ? `${bytes(metrics.memoryLimitBytes)} limit`
                      : "container memory",
                  ],
                  [
                    "Uptime",
                    ClockIcon,
                    metrics ? uptime(metrics.uptimeSeconds) : "—",
                    metrics
                      ? `${metrics.restarts} container restarts`
                      : "since container start",
                  ],
                  [
                    "Processes",
                    ListBulletsIcon,
                    metrics ? String(metrics.processes) : "—",
                    "threads and processes",
                  ],
                ] as const
              ).map(([label, Icon, value, detail]) => (
                <div
                  key={label}
                  className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-transparent ring-1 ring-border"
                >
                  <h2 className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground">
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    {label}
                  </h2>
                  <div className="relative flex flex-1 flex-col gap-3 rounded-lg bg-card p-4 ring-1 ring-border">
                    <p className="text-3xl font-medium tracking-tight tabular-nums">
                      {value}
                    </p>
                    <p className="text-xs text-muted-foreground">{detail}</p>
                  </div>
                </div>
              ))}
            </div>
            <ServiceCharts id={id} component={primary?.name} />
            {primary &&
              service.topology?.dependencies.some(
                (edge) => edge.from === primary.name,
              ) && (
                <section className="space-y-3">
                  <h2 className="text-sm font-medium">Dependencies</h2>
                  {service.topology.dependencies
                    .filter((edge) => edge.from === primary.name)
                    .map((edge) => (
                      <div
                        key={edge.to}
                        className="rounded-lg border p-4 text-sm"
                      >
                        <p>
                          Uses{" "}
                          {componentLabel(
                            service.topology?.components.find(
                              (component) => component.name === edge.to,
                            ) ?? { name: edge.to, image: "" },
                            service,
                          )}
                        </p>
                        <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                          {edge.variables.join(", ")}
                        </p>
                      </div>
                    ))}
                </section>
              )}
          </div>
        )}
        {tab === "Deployments" &&
          (selectedDeployment ? (
            <DeploymentInspector
              key={selectedDeployment}
              id={selectedDeployment}
              service={service}
              data={data}
              onBack={() => setSelectedDeployment(null)}
            />
          ) : (
            <section className="space-y-6">
              <div
                className={`overflow-hidden rounded-xl border ${status === "Running" ? "border-emerald-600/25 bg-emerald-500/5" : "bg-card"}`}
              >
                <div className="flex flex-wrap items-center gap-4 p-5">
                  <ServiceStatus status={status} badge />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    disabled={!currentDeployment}
                    onClick={() =>
                      currentDeployment &&
                      setSelectedDeployment(currentDeployment.id)
                    }
                  >
                    <h2 className="truncate font-medium">
                      {currentDeployment?.source_ref
                        ? `Commit ${currentDeployment.source_ref.slice(0, 8)}`
                        : service.name}
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {currentDeployment
                        ? new Date(
                            currentDeployment.created_at,
                          ).toLocaleString()
                        : service.currentDeployment
                          ? "Deployment record unavailable"
                          : "No active deployment"}
                      {currentDeployment &&
                        ` · ${service.source.type === "github" ? "GitHub" : service.spec.catalog ? "App catalog" : "Container image"}`}
                    </p>
                  </button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      currentDeployment
                        ? setSelectedDeployment(currentDeployment.id)
                        : setTab("Logs")
                    }
                  >
                    View logs
                  </Button>
                </div>
                <Collapsible className="border-t border-inherit px-5 py-3">
                  <CollapsibleTrigger className="text-xs text-muted-foreground">
                    {currentDeployment?.status === "succeeded" &&
                    ["deploy", "rollback"].includes(currentDeployment.action)
                      ? "Deployment successful"
                      : "Deployment details"}
                  </CollapsibleTrigger>
                  <CollapsibleContent keepMounted>
                    <dl className="mt-3 space-y-2 text-xs text-muted-foreground">
                      <div>
                        <dt className="font-medium">Image</dt>
                        <dd className="mt-1 break-all font-mono">
                          {currentDeployment?.digest ??
                            service.spec.image ??
                            "Unavailable"}
                        </dd>
                      </div>
                      {primary && (
                        <div>
                          <dt className="font-medium">Scope</dt>
                          <dd>
                            Deployments, restarts and backups apply to{" "}
                            {service.topology?.components.length === 1
                              ? "this app"
                              : `all ${service.topology?.components.length} app components`}
                            .
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CollapsibleContent>
                </Collapsible>
              </div>
              <div className="space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  History
                </h3>
                {data.builds
                  .filter(
                    (b) =>
                      b.service_id === service.id &&
                      !data.deployments.some((d) => d.id === b.id),
                  )
                  .map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between gap-3 rounded-xl border p-4"
                    >
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => setSelectedDeployment(b.id)}
                      >
                        <span className="text-sm capitalize">
                          Build · {b.status}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {new Date(b.created_at).toLocaleString()}
                        </span>
                        {b.error && (
                          <span className="mt-2 block text-xs text-destructive">
                            {errorMessage(b.error)}
                          </span>
                        )}
                      </button>
                      {["queued", "running", "built"].includes(b.status) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api("/services/builds/cancel", {
                                id: b.id,
                              });
                            })
                          }
                        >
                          Cancel build
                        </Button>
                      )}
                    </div>
                  ))}
                {data.deployments
                  .filter(
                    (d) =>
                      d.service_id === service.id &&
                      d.id !== service.currentDeployment,
                  )
                  .map((d) => (
                    <div
                      key={d.id}
                      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-muted/35 px-5 py-4 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => setSelectedDeployment(d.id)}
                          className="flex w-full items-center gap-4 text-left"
                        >
                          <ServiceStatus
                            status={
                              d.status.charAt(0).toUpperCase() +
                              d.status.slice(1)
                            }
                            badge
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {d.source_ref
                                ? `Commit ${d.source_ref.slice(0, 8)}`
                                : d.action === "deploy"
                                  ? service.name
                                  : d.action.charAt(0).toUpperCase() +
                                    d.action.slice(1)}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {new Date(d.created_at).toLocaleString()} ·{" "}
                              {d.action === "deploy" ? "Deployment" : d.action}
                            </span>
                          </span>
                        </button>
                        {d.error && (
                          <p className="text-xs text-destructive">
                            {errorMessage(d.error)} The data and previous
                            deployment were retained. Stateful apps may remain
                            stopped after a failed operation. Check the worker
                            logs if recovery is still pending.
                          </p>
                        )}
                      </div>
                      {d.status === "queued" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api("/services/cancel", { id: d.id });
                            })
                          }
                        >
                          Cancel
                        </Button>
                      ) : d.status === "succeeded" &&
                        d.digest &&
                        !service.spec.catalog &&
                        !service.spec.volumes?.length &&
                        service.currentDeployment !== d.id ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy ||
                            !!active ||
                            !ready(service.machineId) ||
                            !service.currentDeployment
                          }
                          onClick={() => action(service, "rollback", d.id)}
                        >
                          Roll back
                        </Button>
                      ) : null}
                    </div>
                  ))}
                {!data.builds.some((b) => b.service_id === service.id) &&
                  !data.deployments.some(
                    (d) =>
                      d.service_id === service.id &&
                      d.id !== service.currentDeployment,
                  ) && (
                    <p className="text-sm text-muted-foreground">
                      No previous deployments.
                    </p>
                  )}
              </div>
            </section>
          ))}
        {tab === "Security" && <SecurityWorkspace serviceId={service.id} />}
        {tab === "Logs" && (
          <section
            className={
              drawer ? "space-y-3" : "space-y-3 rounded-xl border bg-card p-5"
            }
          >
            <h2 className="font-medium">
              {primary
                ? `${service.name} logs · ${primary.name} component`
                : "Application logs"}
            </h2>
            <p className="text-xs text-muted-foreground">
              {primary
                ? "Recent output from the primary component, refreshed with worker reports."
                : "Last 60 lines, refreshed with worker reports."}{" "}
              Exact environment values are redacted; avoid logging secrets in
              your application.
              {primary &&
                service.runtimeAt < Date.now() - 120000 &&
                " The worker has not reported recently; showing the last received output."}
            </p>
            <pre className={code}>
              {logs === undefined
                ? primaryRuntime
                  ? "Update the machine’s worker to receive component logs."
                  : "No logs received yet."
                : logs || "No recent output from this component."}
            </pre>
          </section>
        )}
        {tab === (drawer ? "Settings" : "Setup & data") &&
          (service.spec.catalog || service.spec.volumes?.length) && (
            <CatalogDetails
              key={service.id}
              service={service}
              onOpenDomains={() => setTab(domainsTab)}
              recoveryRequired={status === "Recovery required"}
              busy={busy || !!active || !ready(service.machineId)}
              run={run}
              onAction={async (action, backupId) =>
                run(async () => {
                  await api(`/services/${service.id}/action`, {
                    action,
                    backupId,
                  });
                  setNotice(
                    "Operation queued. Follow progress in Deployments.",
                  );
                })
              }
            />
          )}
        {primary ? (
          tab === "Variables" && (
            <ComponentVariables id={id} name={primary.name} />
          )
        ) : (
          <div hidden={tab !== "Variables"}>
            <ServiceVariables
              id={id}
              onSaved={refresh}
              onPendingChange={handlePending}
            />
          </div>
        )}
        {tab === "Settings" && !service.spec.catalog && (
          <section
            className={
              drawer ? "space-y-6" : "space-y-6 rounded-xl border bg-card p-5"
            }
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">Configuration</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {service.spec.memoryMb} MiB memory limit · {service.spec.cpus}{" "}
                  CPU limit · Health check {service.spec.healthPath}
                </p>
              </div>
              <Button variant="outline" onClick={() => setOpen(true)}>
                Edit configuration
              </Button>
            </div>
          </section>
        )}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto overscroll-none sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Configure {service.name}</SheetTitle>
            <SheetDescription>
              Changes apply to the next deployment.
            </SheetDescription>
          </SheetHeader>
          <ServiceForm
            key={String(open)}
            service={service}
            machines={machines}
            onSaved={async (_id, message) => {
              setNotice(message);
              setOpen(false);
              await refresh();
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
