import type { MachineDetail } from "@ephor/api/machines";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { HardDriveIcon } from "@phosphor-icons/react/dist/csr/HardDrive";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { MachineCharts } from "@/components/machines/machine-charts";
import { MachineServices } from "@/components/machines/machine-services";
import { MachineSettings } from "@/components/machines/machine-settings";
import { MachineStatus } from "@/components/machines/machine-status";
import { ProviderLabel } from "@/components/provider-label";
import { Button } from "@/components/ui/button";
import { Usage } from "@/components/usage-meter";
import { api, signIn } from "@/lib/auth";
import { primaryAddress } from "@/lib/machine-address";
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
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState("Overview");
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
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const { machine, releaseInfo } = data;
  const metrics = machine.telemetry;
  const root = metrics?.disks.find((disk) => disk.mount === "/");
  const online = machine.status === "online";
  const memoryPercent = metrics
    ? (metrics.memoryUsed / metrics.memoryTotal) * 100
    : 0;
  return (
    <div className="min-w-0 space-y-7">
      <Link
        to="/machines"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon />
        Machines
      </Link>
      <header>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className="page-title flex min-w-0 items-center gap-2.5">
            <HardDrivesIcon
              aria-hidden="true"
              className="size-6 shrink-0 text-muted-foreground"
            />
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
      {!online && (
        <p
          role="status"
          className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
        >
          {metrics
            ? `Showing last reported values from ${machine.lastSeen ? new Date(machine.lastSeen).toLocaleString() : "an earlier report"}. These readings are not live.`
            : machine.status === "pending"
              ? "Waiting for enrollment. Run the install command on this machine to connect it."
              : machine.status === "expired"
                ? "The enrollment command expired. Generate a new command from the machine list."
                : machine.status === "revoked"
                  ? "This machine is disconnected. Its credential can no longer send reports."
                  : "Waiting for the machine’s first metrics report."}
          {(machine.status === "pending" || machine.status === "expired") && (
            <Link to="/machines" className="ml-1 underline underline-offset-4">
              Manage enrollment
            </Link>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <nav
          aria-label="Machine sections"
          className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1"
        >
          {["Overview", "Services", "Canvas", "Storage", "Settings"].map(
            (value) => (
              <button
                type="button"
                key={value}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={`rounded-md px-3 py-1.5 text-sm ${tab === value ? "bg-card" : "text-muted-foreground"}`}
              >
                {value}
              </button>
            ),
          )}
        </nav>
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1 text-right text-sm text-muted-foreground">
          <ProviderLabel
            name={machine.providerOverride ?? metrics?.hosting?.provider}
          />
          <span className="wrap-anywhere font-mono text-xs">
            {primaryAddress(metrics?.ipAddresses) ?? "IP unavailable"}
          </span>
          {metrics && (
            <span className="wrap-anywhere">
              {metrics.os} · {metrics.arch}
            </span>
          )}
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
                  metrics ? `${metrics.cpuPercent.toFixed(1)}%` : "—",
                  metrics
                    ? `${metrics.cpuCount} ${metrics.cpuCount === 1 ? "core" : "cores"}`
                    : "Waiting for report",
                ],
                [
                  "Memory",
                  MemoryIcon,
                  metrics ? bytes(metrics.memoryUsed) : "—",
                  metrics
                    ? `${bytes(metrics.memoryTotal)} total · ${memoryPercent.toFixed(1)}% used`
                    : "Waiting for report",
                ],
                [
                  "Root disk /",
                  HardDriveIcon,
                  root
                    ? `${((root.used / root.total) * 100).toFixed(1)}%`
                    : "—",
                  root
                    ? `${bytes(root.total - root.used)} free of ${bytes(root.total)}`
                    : "Root filesystem not reported",
                ],
                [
                  "Uptime",
                  ClockIcon,
                  metrics ? uptime(metrics.uptime) : "—",
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
      {tab === "Storage" && (
        <section className="space-y-5 rounded-xl border bg-card p-5">
          <div>
            <h2 className="font-medium">Mounted filesystems</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Latest reported capacity for each mount. Mounts may share the same
              underlying disk.
            </p>
          </div>
          {metrics?.disks.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {metrics.disks.map((disk) => (
                <div
                  key={disk.mount}
                  className="space-y-3 rounded-lg border p-4"
                >
                  <h3 className="break-all font-mono text-sm">{disk.mount}</h3>
                  <Usage
                    label={`Filesystem ${disk.mount}`}
                    percent={(disk.used / disk.total) * 100}
                    detail={`${bytes(disk.used)} / ${bytes(disk.total)}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    {bytes(disk.used)} used of {bytes(disk.total)} ·{" "}
                    {bytes(disk.total - disk.used)} free
                    {disk.used / disk.total >= 0.85
                      ? " · Storage is running low"
                      : ""}
                  </p>
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
      {tab === "Settings" && (
        <section className="space-y-5 rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">Provider & daemon</h2>
            {releaseInfo?.configured && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/machines/updates/check", {});
                  })
                }
              >
                Check for updates
              </Button>
            )}
          </div>
          <MachineSettings
            machine={machine}
            busy={busy}
            releaseInfo={releaseInfo}
            job={data.updates[0]}
            saveProvider={async (provider) => {
              await api("/machines/provider", { id, provider });
              await refresh();
            }}
            update={() => {
              if (
                confirm(
                  `Update the Ephor daemon on “${machine.name}” to ${releaseInfo?.release?.version}? Monitoring will briefly restart. Your services will keep running.`,
                )
              )
                void run(async () => {
                  await signIn();
                  await api("/machines/updates", { id });
                  setNotice("Daemon update queued.");
                });
            }}
            revoke={() => {
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
          />
        </section>
      )}
    </div>
  );
}
