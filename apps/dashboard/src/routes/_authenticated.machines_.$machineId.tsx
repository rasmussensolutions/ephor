import type { MachineDetail } from "@ephor/api/machines";
import { PlugIcon, PlusIcon } from "@phosphor-icons/react";

import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { HardDriveIcon } from "@phosphor-icons/react/dist/csr/HardDrive";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { MachineCharts } from "@/components/machines/machine-charts";
import { MachineMaintenance } from "@/components/machines/machine-maintenance";
import { MachineServices } from "@/components/machines/machine-services";
import { MachineSettings } from "@/components/machines/machine-settings";
import { MachineStatus } from "@/components/machines/machine-status";
import { ProviderIcon } from "@/components/provider-label";
import { SecurityWorkspace } from "@/components/security/security-workspace";

import { Button } from "@/components/ui/button";
import { Usage } from "@/components/usage-meter";
import { api, signIn } from "@/lib/auth";

import { currentMachineMetrics } from "@/lib/machine-metrics";
import { bytes, uptime } from "@/lib/services";

export const Route = createFileRoute("/_authenticated/machines_/$machineId")({
  loader: ({ params }) => api<MachineDetail>(`/machines/${params.machineId}`),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.machine.name ?? "Machine"} — Ephor` }],
  }),
  errorComponent: ({ error, reset }) => (
    <div className="space-y-4">
      <Link to="/machines" className="text-sm underline">
        Back to machines
      </Link>
      <h1 className="page-title">Machine unavailable</h1>
      <p role="alert" className="text-sm text-muted-foreground">
        {error instanceof Error
          ? error.message
          : "Could not load this machine."}
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  ),
  component: MachineRoute,
});
function MachineRoute() {
  const initial = Route.useLoaderData();
  return <MachinePage key={initial.machine.id} initial={initial} />;
}
function MachinePage({ initial }: { initial: MachineDetail }) {
  const navigate = useNavigate();
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(Date.now);
  const [tab, setTab] = useState("Overview");
  useEffect(() => {
    const select = () => {
      if (window.location.hash === "#maintenance") setTab("Maintenance");
    };
    select();
    window.addEventListener("hashchange", select);
    return () => window.removeEventListener("hashchange", select);
  }, []);
  const [refreshError, setRefreshError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const id = initial.machine.id;
  const refresh = useCallback(async () => {
    setData(await api<MachineDetail>(`/machines/${id}`));
    setRefreshError("");
  }, [id]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!document.hidden) {
        try {
          const next = await api<MachineDetail>(`/machines/${id}`);
          if (active) {
            setData(next);
            setRefreshError("");
          }
        } catch {
          if (active)
            setRefreshError(
              "Could not refresh this machine. Values may be out of date. Retrying automatically.",
            );
        }
      }
      if (active) timer = setTimeout(poll, 15000);
    }
    timer = setTimeout(poll, 15000);
    const clock = setInterval(() => setNow(Date.now()), 15000);
    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const { machine, releaseInfo } = data;
  const metrics = machine.telemetry;
  const provider = machine.providerOverride ?? metrics?.hosting?.provider;
  const currentMetrics = currentMachineMetrics(machine, now);
  const root = metrics?.disks.find((disk) => disk.mount === "/");
  const currentRoot = currentMetrics?.disks.find((disk) => disk.mount === "/");
  const memoryPercent =
    currentMetrics && currentMetrics.memoryTotal > 0
      ? (currentMetrics.memoryUsed / currentMetrics.memoryTotal) * 100
      : null;
  return (
    <div className="min-w-0 space-y-7">
      <header>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className="page-title flex min-w-0 items-center gap-2.5">
            <span
              className="flex shrink-0"
              title={provider || "Unknown provider"}
            >
              <ProviderIcon name={provider} className="size-6" />
            </span>
            <span className="wrap-anywhere">{machine.name}</span>
          </h1>
          <MachineStatus status={machine.status} />
        </div>
      </header>
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
      {(machine.status === "pending" || machine.status === "expired") && (
        <p className="text-sm text-muted-foreground">
          {machine.status === "pending"
            ? "Run the install command on this machine to connect it."
            : "Generate a new enrollment command to connect this machine."}
          <Link to="/machines" className="ml-1 underline underline-offset-4">
            Manage enrollment
          </Link>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <nav
          aria-label="Machine sections"
          className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1"
        >
          {[
            "Overview",
            "Services",
            "Canvas",
            "Storage",
            "Security",
            "Maintenance",
            "Settings",
          ].map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
                void navigate({
                  hash: value === "Maintenance" ? "maintenance" : "",
                  replace: true,
                });
              }}
              className={`rounded-md px-3 py-1.5 text-sm ${tab === value ? "bg-card" : "text-muted-foreground"}`}
            >
              {value}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="destructive-gradient"
            size="action"
            aria-label={`Disconnect ${machine.name}`}
            disabled={busy || machine.status === "revoked"}
            onClick={() => {
              if (
                confirm(
                  `Disconnect “${machine.name}”? Its credential and any pending enrollment command will stop working. Services on the VPS will keep running.`,
                )
              )
                void run(async () => {
                  await signIn();
                  await api("/machines/revoke", { id });
                  setNotice("Machine disconnected.");
                });
            }}
          >
            <PlugIcon
              aria-hidden="true"
              data-icon="inline-start"
              className="size-[1em]"
            />
            Disconnect
          </Button>
          <Button
            variant="gradient"
            size="action"
            disabled={busy || machine.status === "revoked"}
            onClick={() =>
              void navigate({ to: "/services/new", search: { machineId: id } })
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
      </div>
      {tab === "Overview" && (
        <div className="space-y-7">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                [
                  "CPU",
                  CpuIcon,
                  currentMetrics
                    ? `${currentMetrics.cpuPercent.toFixed(1)}%`
                    : "—",
                  metrics
                    ? `${metrics.cpuCount} ${metrics.cpuCount === 1 ? "core" : "cores"}`
                    : "Waiting for report",
                ],
                [
                  "Memory",
                  MemoryIcon,
                  currentMetrics ? bytes(currentMetrics.memoryUsed) : "—",
                  metrics
                    ? `${bytes(metrics.memoryTotal)} total${memoryPercent !== null ? ` · ${memoryPercent.toFixed(1)}% used` : ""}`
                    : "Waiting for report",
                ],
                [
                  "Root disk /",
                  HardDriveIcon,
                  currentRoot
                    ? `${((currentRoot.used / currentRoot.total) * 100).toFixed(1)}%`
                    : "—",
                  currentRoot
                    ? `${bytes(currentRoot.total - currentRoot.used)} free of ${bytes(currentRoot.total)}`
                    : root
                      ? `${bytes(root.total)} total`
                      : "Root filesystem not reported",
                ],
                [
                  "Uptime",
                  ClockIcon,
                  currentMetrics ? uptime(currentMetrics.uptime) : "—",
                  "Since the last host restart",
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
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={detail}
                  >
                    {detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <MachineCharts id={id} />
          <section className="space-y-4 rounded-xl border bg-card p-5">
            <h2 className="font-medium">Machine information</h2>
            <dl className="grid gap-5 text-sm sm:grid-cols-2 xl:grid-cols-3">
              {[
                ["Hostname", metrics?.hostname ?? "Not reported"],
                [
                  "Region / zone",
                  [metrics?.hosting?.region, metrics?.hosting?.zone]
                    .filter(Boolean)
                    .join(" / ") || "Not reported",
                ],
                ["Daemon", metrics?.agentVersion ?? "Not reported"],
                ["Added", new Date(machine.createdAt).toLocaleString()],
                [
                  "Last report",
                  machine.lastSeen
                    ? new Date(machine.lastSeen).toLocaleString()
                    : "Never",
                ],
                [
                  "Interface addresses",
                  metrics?.ipAddresses?.join(", ") || "Not reported",
                ],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
      {(tab === "Services" || tab === "Canvas") && (
        <MachineServices id={id} view={tab === "Canvas" ? "canvas" : "table"} />
      )}
      {tab === "Security" && <SecurityWorkspace machineId={id} />}
      {tab === "Storage" && (
        <section aria-label="Storage" className="min-w-0">
          {metrics?.disks.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {metrics.disks.map((disk) => (
                <div
                  key={disk.mount}
                  className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-transparent ring-1 ring-border"
                >
                  <h2 className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground">
                    <HardDriveIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    <span className="truncate font-mono" title={disk.mount}>
                      {disk.mount}
                    </span>
                  </h2>
                  <div className="relative flex flex-1 flex-col gap-3 rounded-lg bg-card p-4 ring-1 ring-border">
                    <Usage
                      label={`Filesystem ${disk.mount}`}
                      percent={
                        currentMetrics ? (disk.used / disk.total) * 100 : null
                      }
                      detail={`${bytes(disk.used)} / ${bytes(disk.total)}`}
                    />
                    <p className="text-xs text-muted-foreground">
                      {currentMetrics ? (
                        <>
                          {bytes(disk.used)} used of {bytes(disk.total)} ·{" "}
                          {bytes(disk.total - disk.used)} free
                          {disk.used / disk.total >= 0.85
                            ? " · Storage is running low"
                            : ""}
                        </>
                      ) : (
                        `${bytes(disk.total)} total`
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No filesystems reported yet.
            </p>
          )}
        </section>
      )}
      {tab === "Maintenance" && (
        <MachineMaintenance
          machine={machine}
          releaseInfo={releaseInfo}
          job={data.updates[0]}
          refresh={refresh}
        />
      )}
      {tab === "Settings" && (
        <section className="space-y-5 rounded-xl border bg-card p-5">
          <h2 className="font-medium">Provider</h2>
          <MachineSettings
            machine={machine}
            busy={busy}
            saveProvider={async (provider) => {
              await api("/machines/provider", { id, provider });
              await refresh();
            }}
          />
        </section>
      )}
    </div>
  );
}
