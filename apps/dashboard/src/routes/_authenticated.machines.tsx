import type { Machine, MachineList } from "@ephor/api/machines";
import { CubeIcon } from "@phosphor-icons/react";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { HardDriveIcon } from "@phosphor-icons/react/dist/csr/HardDrive";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CopyEnrollmentCommand,
  EnrollmentCommand,
} from "@/components/machines/enrollment-command";
import { MachineActionDialog } from "@/components/machines/machine-action-dialog";
import { MachineStatus } from "@/components/machines/machine-status";
import { ProviderLabel } from "@/components/provider-label";
import { SummaryCards } from "@/components/summary-cards";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Usage } from "@/components/usage-meter";
import { api, signIn } from "@/lib/auth";
import { currentMachineMetrics } from "@/lib/machine-metrics";
import { machineSummary } from "@/lib/machine-summary";

export const Route = createFileRoute("/_authenticated/machines")({
  validateSearch: (search: Record<string, unknown>): { connect?: boolean } => ({
    connect:
      search.connect === true || search.connect === "true" ? true : undefined,
  }),
  head: () => ({ meta: [{ title: "Machines — Ephor" }] }),
  loader: () => api<MachineList>("/machines"),
  component: MachinesPage,
});

interface Enrollment {
  id: string;
  command: string;
  expiresAt: number;
}

function MachinesPage() {
  const initial = Route.useLoaderData();
  const { connect } = Route.useSearch();
  const navigate = useNavigate();
  const [data, setData] = useState(initial);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!connect) return;
    setOpen(true);
    void navigate({ to: "/machines", search: {}, replace: true });
  }, [connect, navigate]);
  const [name, setName] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [enrollmentMachineId, setEnrollmentMachineId] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [machineAction, setMachineAction] = useState<{
    machine: Machine;
    action: "rename" | "disconnect";
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogHeightBeforeCommand = useRef<number | null>(null);
  useEffect(() => {
    setData(initial);
  }, [initial]);
  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.visibilityState === "visible") {
        try {
          const next = await api<MachineList>("/machines");
          if (active) {
            setData(next);
            setPollError(false);
          }
        } catch {
          if (active) setPollError(true);
        }
      }
      if (active) timeout = setTimeout(poll, 15_000);
    }
    timeout = setTimeout(poll, 15_000);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, []);
  useEffect(() => {
    const timeout = setInterval(
      () => setNow(Date.now()),
      enrollment ? 1000 : 15_000,
    );
    return () => clearInterval(timeout);
  }, [enrollment]);

  const enrolledMachine = data.machines.find(
    (machine) => machine.id === enrollment?.id,
  );
  const connected =
    enrolledMachine?.status === "online" ||
    enrolledMachine?.status === "connecting";
  const expired = enrollment !== null && now >= enrollment.expiresAt;
  const revoked = enrolledMachine?.status === "revoked";
  const activeEnrollment =
    enrollment && !connected && !expired && !revoked ? enrollment : null;

  useLayoutEffect(() => {
    const previousHeight = dialogHeightBeforeCommand.current;
    dialogHeightBeforeCommand.current = null;
    const dialog = dialogRef.current;
    if (!open || !activeEnrollment || !dialog || previousHeight === null)
      return;

    dialogTitleRef.current?.focus({ preventScroll: true });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const nextHeight = dialog.offsetHeight;
    if (previousHeight === nextHeight) return;

    const animation = dialog.animate(
      [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
      { duration: 260, easing: "ease-in-out" },
    );
    return () => animation.cancel();
  }, [open, activeEnrollment]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setData(await api<MachineList>("/machines"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function cancelEnrollment(machine: Machine) {
    if (
      !confirm(
        `Cancel enrollment for “${machine.name}”? Its install command will stop working.`,
      )
    )
      return;
    await run(async () => {
      await signIn();
      await api("/machines/enrollments/cancel", { id: machine.id });
      setData((current) => ({
        ...current,
        machines: current.machines.filter((item) => item.id !== machine.id),
      }));
      setEnrollment(null);
      setEnrollmentMachineId(null);
    });
  }
  const feedback = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value, event) => {
          if (busy && !value) {
            event.cancel();
            return;
          }
          setOpen(value);
        }}
      >
        <div className="min-w-0 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="page-title">Machines</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your servers, their health, and resources at a glance.
              </p>
            </div>
            <DialogTrigger
              render={<Button variant="gradient" size="action" />}
              onClick={() => {
                setError("");
                setEnrollment(null);
                setEnrollmentMachineId(null);
                setName("");
              }}
            >
              <PlusIcon
                aria-hidden="true"
                data-icon="inline-start"
                className="size-[1em]"
              />
              Add machine
            </DialogTrigger>
          </div>
          {!open && feedback}

          {pollError && (
            <p
              role="alert"
              className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground"
            >
              Could not refresh machines. Values may be out of date. Retrying
              automatically.
            </p>
          )}
          <MachineSummaryCards machines={data.machines} now={now} />
          {data.machines.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border bg-card px-6 py-16 text-center shadow-xs">
              <HardDrivesIcon
                className="mb-4 size-8 text-muted-foreground"
                weight="duotone"
              />
              <h2 className="font-medium">Connect your first machine</h2>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                Run a command on your Linux VPS to start monitoring CPU, memory,
                and disk usage.
              </p>
              <DialogTrigger
                render={
                  <Button
                    className="mt-5"
                    variant="subtle-outline"
                    size="action"
                  />
                }
              >
                Add machine
              </DialogTrigger>
            </div>
          ) : (
            <Table variant="layered" className="[&_td]:px-3 [&_th]:px-3">
              <caption className="sr-only">
                Machines and their latest resource usage
              </caption>
              <TableHeader>
                <TableRow>
                  {[
                    "Machine",
                    "Provider",
                    "Status",
                    "CPU",
                    "Memory",
                    "Disk /",
                    "Last seen",
                  ].map((title) => (
                    <TableHead key={title} scope="col">
                      {title}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.machines.map((machine) => (
                  <MachineRow
                    key={machine.id}
                    machine={machine}
                    now={now}
                    hasCommand={activeEnrollment?.id === machine.id}
                    actionDialogOpen={machineAction?.machine.id === machine.id}
                    onAction={(action) => setMachineAction({ machine, action })}
                    onEnrollment={() => {
                      setError("");
                      setName(machine.name);
                      setEnrollmentMachineId(machine.id);
                      if (activeEnrollment?.id !== machine.id)
                        setEnrollment(null);
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <DialogContent ref={dialogRef} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle
              ref={dialogTitleRef}
              tabIndex={-1}
              className="outline-none"
            >
              {activeEnrollment ? "Run this on your VPS" : "Add a machine"}
            </DialogTitle>
            <DialogDescription>
              {activeEnrollment
                ? "Installs monitoring, deployments and Security, including Docker, build tools and vulnerability scanning. Requires sudo, curl, and systemd."
                : enrollmentMachineId
                  ? "Generate a new install command for this machine. Its previous command will stop working."
                  : "Connect a Linux VPS for monitoring, deployments and Security. Requires systemd and outbound HTTPS."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            {feedback}
            {!data.installer.available && (
              <div className="space-y-2 rounded-lg border bg-background p-4 text-sm">
                <p className="font-medium">Prepare your panel first</p>
                {!data.installer.https && (
                  <p className="text-muted-foreground">
                    Your VPS needs to reach this panel over HTTPS. Configure
                    EPHOR_ORIGIN with your public HTTPS address; localhost on
                    your VPS points to the VPS itself.
                  </p>
                )}
                {(!data.installer.architectures.length ||
                  !data.installer.deployments ||
                  !data.installer.security) && (
                  <p className="text-muted-foreground">
                    This panel needs a Linux agent build with deployment and
                    Security support. Run{" "}
                    <code className="text-foreground">
                      bun run bundle:daemon
                    </code>{" "}
                    in the project before building and deploying the dashboard.
                    See <code>docs/machines.md</code> for setup instructions.
                  </p>
                )}
              </div>
            )}
            {enrollment && connected ? (
              <div className="space-y-2 rounded-xl border bg-card p-5">
                <h3 className="font-medium">
                  {enrolledMachine?.name} is connected
                </h3>
                <p className="text-sm text-muted-foreground">
                  {enrolledMachine?.deploymentWorker &&
                  enrolledMachine.deploymentWorker.lastSeen > now - 120000
                    ? "Deployments are connected. Let the installer finish, then check the Security tab for collector status."
                    : "Keep the installer running until deployments and Security finish setting up. If either fails, open this machine’s Maintenance tab for one setup or repair command."}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEnrollment(null);
                    setName("");
                    setOpen(false);
                  }}
                >
                  Done
                </Button>
              </div>
            ) : activeEnrollment ? (
              <div className="space-y-4">
                <EnrollmentCommand command={activeEnrollment.command} />
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <CopyEnrollmentCommand
                    command={activeEnrollment.command}
                    onCopyError={setError}
                  />
                  <Button
                    variant="destructive-gradient"
                    size="action"
                    className="min-w-0 leading-tight whitespace-normal"
                    disabled={busy}
                    onClick={() =>
                      enrolledMachine && void cancelEnrollment(enrolledMachine)
                    }
                  >
                    Cancel enrollment
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Single use · expires in{" "}
                  {Math.max(
                    0,
                    Math.ceil((activeEnrollment.expiresAt - now) / 60_000),
                  )}{" "}
                  minutes. Treat this command as a secret until it expires. The
                  page updates automatically when your VPS connects.
                </p>
              </div>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await signIn();
                    const result = await api<Enrollment>(
                      "/machines/enrollments",
                      enrollmentMachineId
                        ? { id: enrollmentMachineId }
                        : { name: name.trim() },
                    );
                    dialogHeightBeforeCommand.current =
                      dialogRef.current?.offsetHeight ?? null;
                    setNow(Date.now());
                    setEnrollment(result);
                    setEnrollmentMachineId(result.id);
                  });
                }}
              >
                {expired && !revoked && (
                  <p role="status" className="text-sm text-muted-foreground">
                    This enrollment has expired. Generate a new command to
                    continue.
                  </p>
                )}
                <div className="space-y-2">
                  <label
                    htmlFor="machine-name"
                    className="block text-sm font-medium"
                  >
                    Machine name
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="machine-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={80}
                      placeholder="Production VPS"
                      autoComplete="off"
                      readOnly={enrollmentMachineId !== null}
                      className="h-9 min-w-24 flex-1"
                    />
                    <Button
                      type="submit"
                      variant="gradient"
                      size="action"
                      disabled={
                        busy || !data.installer.available || !name.trim()
                      }
                    >
                      {busy ? "Verifying…" : "Generate command"}
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
      {machineAction && (
        <MachineActionDialog
          key={`${machineAction.machine.id}-${machineAction.action}`}
          machine={machineAction.machine}
          action={machineAction.action}
          onClose={() => setMachineAction(null)}
          onComplete={(updated) => {
            const { machine, action } = machineAction;
            setData((current) => ({
              ...current,
              machines: updated
                ? current.machines.map((item) =>
                    item.id === machine.id
                      ? {
                          ...item,
                          ...(action === "rename"
                            ? { name: updated.name }
                            : { status: updated.status }),
                        }
                      : item,
                  )
                : current.machines.filter((item) => item.id !== machine.id),
            }));
            if (enrollmentMachineId === machine.id) {
              if (action === "rename" && updated) setName(updated.name);
              else {
                setEnrollment(null);
                setEnrollmentMachineId(null);
              }
            }
            setMachineAction(null);
          }}
        />
      )}
    </>
  );
}

function MachineSummaryCards({
  machines,
  now,
}: {
  machines: Machine[];
  now: number;
}) {
  const summary = machineSummary(machines, now);
  const health = [
    summary.offline ? `${summary.offline} offline` : null,
    summary.waiting ? `${summary.waiting} awaiting reports` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const cards = [
    {
      label: "Machines online",
      icon: CubeIcon,
      value: `${summary.online} / ${summary.total}`,
      segments: { filled: summary.online, total: summary.total },
      detail:
        health ||
        (summary.total ? "All machines online" : "No machines connected"),
      warning: summary.offline > 0,
    },
    {
      label: "CPU usage",
      icon: CpuIcon,
      percent: summary.cpuPercent,
      detail: summary.busiest
        ? `Busiest: ${summary.busiest.name} at ${summary.busiest.percent.toFixed(1)}%`
        : "No live CPU reports",
    },
    {
      label: "Memory usage",
      icon: MemoryIcon,
      percent: summary.memoryPercent,
      detail: summary.memoryTotal
        ? `${bytes(summary.memoryUsed)} of ${bytes(summary.memoryTotal)} used`
        : "No live memory reports",
    },
    {
      label: "Disk usage",
      icon: HardDriveIcon,
      percent: summary.diskPercent,
      detail: summary.disksHigh
        ? `${summary.disksHigh} ${summary.disksHigh === 1 ? "machine" : "machines"} above 85%`
        : summary.diskTotal
          ? `${bytes(summary.diskUsed)} of ${bytes(summary.diskTotal)} used`
          : "No live root disk reports",
      warning: summary.disksHigh > 0,
    },
  ];
  return <SummaryCards label="Machine summary" cards={cards} />;
}

function bytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index = Math.min(
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}
function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function MachineRow({
  machine,
  now,
  hasCommand,
  onEnrollment,
  onAction,
  actionDialogOpen,
}: {
  machine: Machine;
  now: number;
  hasCommand: boolean;
  onEnrollment: () => void;
  onAction: (action: "rename" | "disconnect") => void;
  actionDialogOpen: boolean;
}) {
  const metrics = currentMachineMetrics(machine, now);
  const root = metrics?.disks.find((disk) => disk.mount === "/");

  const detailsLink = useRef<HTMLAnchorElement>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <TableRow className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>td]:border-l [&>td]:py-3 dark:[&>td]:border-l-white/[0.04]" />
        }
        id={`machine-row-${machine.id}`}
        tabIndex={0}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            !(event.target instanceof Element) ||
            !event.currentTarget.contains(event.target) ||
            event.target.closest(
              "a, button, input, select, textarea, [role='button']",
            ) ||
            window.getSelection()?.isCollapsed === false
          )
            return;
          const link = detailsLink.current;
          if (!link) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            window.open(link.href, "_blank", "noopener,noreferrer");
          } else {
            link.click();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget) {
            event.preventDefault();
            detailsLink.current?.click();
          }
        }}
      >
        <TableHead scope="row" className="max-w-72 py-3 text-foreground">
          <Link
            ref={detailsLink}
            to="/machines/$machineId"
            params={{ machineId: machine.id }}
            className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CubeIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="block min-w-0 max-w-full truncate text-sm font-medium">
              {machine.name}
            </span>
            <span className="sr-only">Show machine details</span>
          </Link>
        </TableHead>

        <TableCell
          className="whitespace-nowrap text-xs"
          title={
            machine.providerOverride
              ? "Manually set provider"
              : "Automatically detected provider"
          }
        >
          <ProviderLabel
            name={
              machine.providerOverride ?? machine.telemetry?.hosting?.provider
            }
          />
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {machine.status === "pending" || machine.status === "expired" ? (
            <DialogTrigger
              render={<Button variant="raised" size="sm" />}
              onClick={onEnrollment}
              aria-label={`${hasCommand ? "Show" : "Generate"} command for ${machine.name}`}
            >
              {hasCommand ? "Show command" : "Generate command"}
            </DialogTrigger>
          ) : (
            <MachineStatus status={machine.status} />
          )}
        </TableCell>
        <TableCell>
          {metrics ? (
            <Usage
              label="CPU"
              size="sm"
              percent={metrics.cpuPercent}
              detail={`${metrics.cpuCount} ${metrics.cpuCount === 1 ? "core" : "cores"}`}
            />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          {metrics ? (
            <Usage
              label="Memory"
              size="sm"
              percent={(metrics.memoryUsed / metrics.memoryTotal) * 100}
              detail={`${bytes(metrics.memoryUsed)} / ${bytes(metrics.memoryTotal)}`}
            />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          {root ? (
            <Usage
              label="Root filesystem /"
              size="sm"
              percent={(root.used / root.total) * 100}
              detail={`${bytes(root.used)} / ${bytes(root.total)}`}
            />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
          {machine.lastSeen ? (
            <time
              title={new Date(machine.lastSeen).toLocaleString()}
              dateTime={new Date(machine.lastSeen).toISOString()}
            >
              {relativeTime(machine.lastSeen)}
            </time>
          ) : (
            "Never"
          )}
        </TableCell>
      </ContextMenuTrigger>
      <ContextMenuContent finalFocus={actionDialogOpen ? false : undefined}>
        <ContextMenuItem onClick={() => onAction("rename")}>
          <PencilSimpleIcon aria-hidden="true" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          disabled={machine.status === "revoked" && machine.enrolledAt !== null}
          onClick={() => onAction("disconnect")}
        >
          <PlugIcon aria-hidden="true" />
          {machine.status === "revoked" && machine.enrolledAt === null
            ? "Remove from Ephor"
            : machine.status === "pending" || machine.status === "expired"
              ? "Cancel enrollment"
              : "Disconnect"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
