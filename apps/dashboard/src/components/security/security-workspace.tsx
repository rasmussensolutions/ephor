import type { SecurityOverview, SecurityScan } from "@ephor/api/security";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, signIn } from "@/lib/auth";
import { ManagedProtectionsPanel } from "./managed-protections";
import { SecurityActions as SecurityFindings } from "./security-actions";
import { SecurityAudit } from "./security-audit";
import { label, useSecurityData, when } from "./security-data";
import { SecurityOverviewPanel } from "./security-overview";

export function SecurityWorkspace({
  machineId,
  serviceId,
  initialMachine = "",
  initialService = "",
  initialFinding,
}: {
  machineId?: string;
  serviceId?: string;
  initialMachine?: string;
  initialService?: string;
  initialFinding?: string;
}) {
  const embedded = !!(machineId || serviceId);
  const [machine, setMachine] = useState(initialMachine),
    [service, setService] = useState(initialService),
    [tab, setTab] = useState(
      embedded || initialFinding || initialMachine || initialService
        ? "Findings"
        : "Overview",
    );
  const [focusedFinding, setFocusedFinding] = useState(initialFinding);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [command, setCommand] = useState<{
    command: string;
    expiresAt: number;
  } | null>(null);
  const selectedMachine = machineId ?? machine,
    selectedService = serviceId ?? service;
  const scope = new URLSearchParams();
  if (selectedMachine) scope.set("machine", selectedMachine);
  if (selectedService) scope.set("service", selectedService);
  const filter = scope.toString();
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = useSecurityData<SecurityOverview>(`/security/overview?${filter}`);
  const resourceMachine =
    selectedMachine ||
    data?.services.find((s) => s.id === selectedService)?.machineId;
  const agent = data?.machines.find((m) => m.id === resourceMachine);
  const selectedTarget = selectedService
    ? `service:${selectedService}`
    : resourceMachine
      ? `machine:${resourceMachine}`
      : null;
  const activeScan = data?.scans.find((s) => s.target === selectedTarget);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Security action failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function setup() {
    if (!resourceMachine) return;
    void run(async () => {
      await signIn();
      setCommand(
        await api("/security/collector", { machineId: resourceMachine }),
      );
    });
  }
  return (
    <div className="space-y-6">
      {!embedded && (
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="page-title">Security</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Findings, exposure and security activity across your
              infrastructure.
            </p>
          </div>
          <ShieldCheckIcon
            className="size-6 text-muted-foreground"
            aria-hidden="true"
          />
        </header>
      )}
      {(error || loadError) && (
        <div
          role="alert"
          className="flex items-center gap-3 text-sm text-destructive"
        >
          <p>{error || loadError}</p>
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {loading && !data && (
        <div role="status" className="space-y-3 py-6">
          <div className="h-6 w-40 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded-lg bg-muted" />
          <span className="sr-only">Loading security overview</span>
        </div>
      )}
      {data && (
        <>
          {!embedded && tab !== "Overview" && (
            <div className="flex flex-wrap gap-2">
              <Select
                aria-label="Filter by machine"
                value={machine}
                onValueChange={(value) => {
                  setMachine(value);
                  setService("");
                  setCommand(null);
                }}
                options={[
                  { value: "", label: "All machines" },
                  ...data.machines.map((m) => ({ value: m.id, label: m.name })),
                ]}
              />
              <Select
                aria-label="Filter by service"
                value={service}
                onValueChange={(value) => {
                  setService(value);
                  setCommand(null);
                }}
                options={[
                  { value: "", label: "All services" },
                  ...data.services
                    .filter((s) => !machine || s.machineId === machine)
                    .map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </div>
          )}
          {resourceMachine && tab !== "Overview" && (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-4 py-3">
              <div className="text-sm">
                <p className="font-medium">
                  {agent?.enabled
                    ? agent.lastSeen
                      ? Date.now() - agent.lastSeen < 30 * 60000
                        ? "Security helper reporting"
                        : "Security reporting is stale"
                      : "Waiting for first security report"
                    : "Security collection not enabled"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {agent?.lastSeen
                    ? `Last report ${when(agent.lastSeen)}`
                    : "Enable the dedicated helper to inspect this machine and scan its service images."}
                  {activeScan
                    ? ` · Latest scan: ${label(activeScan.status)}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {agent?.enabled && (
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      ["queued", "running"].includes(activeScan?.status ?? "")
                    }
                    onClick={() =>
                      void run(async () => {
                        await api("/security/scan", {
                          machineId: resourceMachine,
                          serviceId: selectedService || undefined,
                        });
                        setNotice(
                          "Scan queued. Results will appear when the helper completes it.",
                        );
                      })
                    }
                  >
                    <ArrowClockwiseIcon />
                    {["queued", "running"].includes(activeScan?.status ?? "")
                      ? "Scan in progress"
                      : "Scan now"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !data.installerAvailable ||
                    agent?.state !== "active"
                  }
                  onClick={setup}
                >
                  {agent?.enabled ? "Repair helper" : "Enable collection"}
                </Button>
              </div>
            </div>
          )}
          {resourceMachine && !data.installerAvailable && (
            <p className="text-xs text-muted-foreground">
              Collector installation requires a bundled daemon release with
              Security support. Existing results remain available.
            </p>
          )}
          {command && (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="text-sm font-medium">Run on {agent?.name}</p>
              <p className="text-xs text-muted-foreground">
                Installs Ephor’s security helper and a pinned Trivy release.
                Requires root and outbound HTTPS. Enrollment expires{" "}
                {when(command.expiresAt)}. The helper reads host security
                settings and Docker metadata; it does not change firewall or SSH
                policies.
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs select-all">
                {command.command}
              </pre>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(command.command)
                      .then(() => setNotice("Install command copied."))
                      .catch(() =>
                        setError(
                          "Copy failed. Select and copy the command manually.",
                        ),
                      )
                  }
                >
                  Copy command
                </Button>
                <Button variant="ghost" onClick={() => setCommand(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          <nav
            aria-label="Security sections"
            className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1 w-fit"
          >
            {[
              ...(!embedded ? ["Overview"] : []),
              "Findings",
              "Coverage",
              "Audit",
              ...(!embedded ? ["Panel", "Settings"] : []),
            ].map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${tab === value ? "bg-card" : "text-muted-foreground"}`}
              >
                {value}
              </button>
            ))}
          </nav>
          {tab === "Overview" && (
            <SecurityOverviewPanel
              data={data}
              onSection={setTab}
              onFinding={(id) => {
                setFocusedFinding(id);
                setMachine("");
                setService("");
                setTab("Findings");
              }}
            />
          )}
          {tab === "Findings" && (
            <SecurityFindings
              key={`${filter}:${focusedFinding ?? ""}`}
              scope={filter}
              initialFinding={focusedFinding}
              onChange={refresh}
            />
          )}
          {tab === "Audit" && <SecurityAudit key={filter} scope={filter} />}
          {tab === "Coverage" && (
            <Coverage
              data={data}
              machine={resourceMachine}
              service={selectedService}
              scan={activeScan}
            />
          )}
          {embedded && !serviceId && (
            <ManagedProtectionsPanel machineId={resourceMachine} />
          )}
          {tab === "Panel" && <PanelSecurity />}
          {tab === "Settings" && (
            <div className="max-w-2xl space-y-6">
              <Retention days={data.retentionDays} changed={refresh} />
              {agent?.enabled && resourceMachine && (
                <div className="space-y-3 border-t pt-5">
                  <h3 className="font-medium">
                    Disable collection on {agent.name}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Revokes this helper’s credential. Existing security findings
                    remain available.
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !confirm(
                          `Disable security collection on ${agent.name}?`,
                        )
                      )
                        return;
                      void run(async () => {
                        await signIn();
                        await api("/security/collector/revoke", {
                          machineId: resourceMachine,
                        });
                        setNotice("Security collector access revoked.");
                      });
                    }}
                  >
                    Disable collection
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
function Coverage({
  data,
  machine,
  service,
  scan,
}: {
  data: SecurityOverview;
  machine?: string;
  service?: string;
  scan?: SecurityScan;
}) {
  const inventory = scan?.result?.inventory;
  const scans = data.scans.filter((s) =>
    service
      ? s.serviceId === service
      : machine
        ? s.machineId === machine
        : true,
  );
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Coverage describes what Ephor has observed. A running protection service
        does not prove attacks are being blocked. Public reachability is not
        externally verified.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Resource</TableHead>
            <TableHead>Collector</TableHead>
            <TableHead>Latest scan</TableHead>
            <TableHead>Completed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.machines
            .filter((m) => !machine || m.id === machine)
            .map((m) => {
              const latest = data.scans.find(
                (s) => s.target === `machine:${m.id}`,
              );
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link
                      className="hover:underline"
                      to="/security"
                      search={{ machine: m.id }}
                    >
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {!m.enabled
                      ? "Not enabled"
                      : !m.lastSeen
                        ? "Waiting"
                        : Date.now() - m.lastSeen > 30 * 60000
                          ? "Stale"
                          : "Reporting"}
                  </TableCell>
                  <TableCell>
                    {latest ? label(latest.status) : "Not scanned"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {when(latest?.finishedAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          {data.services
            .filter((s) =>
              service
                ? s.id === service
                : machine
                  ? s.machineId === machine
                  : true,
            )
            .map((s) => {
              const latest = scans.find((v) => v.serviceId === s.id);
              return (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link
                      className="hover:underline"
                      to="/security"
                      search={{ service: s.id }}
                    >
                      {s.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {s.domain
                        ? `Public domain: ${s.domain}`
                        : "No public domain configured"}
                    </p>
                  </TableCell>
                  <TableCell>Image + container checks</TableCell>
                  <TableCell>
                    {latest
                      ? latest.revision !== s.currentDeployment
                        ? "Deployment changed"
                        : label(latest.status)
                      : "Not scanned"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {when(latest?.finishedAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          {!data.machines.length && (
            <TableRow>
              <TableCell
                colSpan={4}
                className="py-10 text-center text-muted-foreground"
              >
                Connect a machine to start collecting security evidence.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {scan?.error && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
          Scan incomplete: {label(scan.error)}. Existing findings have been
          retained.
        </p>
      )}
      {scan?.result && (
        <>
          <div className="space-y-3">
            <h3 className="text-sm font-medium">
              Checks {inventory?.os ? `· ${inventory.os}` : ""}
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scan.result.checks.map((c) => (
                  <TableRow key={`${c.key}:${c.component}`}>
                    <TableCell className="whitespace-normal">
                      <p>{c.title}</p>
                      {c.component && (
                        <p className="text-xs text-muted-foreground">
                          {c.component}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          c.status === "fail"
                            ? "text-destructive"
                            : c.status === "pass"
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-muted-foreground"
                        }
                      >
                        {label(c.status)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-xl whitespace-normal text-xs text-muted-foreground">
                      {c.evidence}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {scan.result.scanner && (
            <p className="text-xs text-muted-foreground">
              Trivy {scan.result.scanner.version} · Vulnerability database
              updated {when(scan.result.scanner.databaseUpdatedAt)} ·{" "}
              {scan.result.vulnerabilitiesComplete
                ? "All discovered images scanned"
                : "Image coverage incomplete"}
            </p>
          )}
          {!!inventory?.ports.length && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Listening ports</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Protocol</TableHead>
                    <TableHead>Bind address</TableHead>
                    <TableHead>Port</TableHead>
                    <TableHead>Process</TableHead>
                    <TableHead>Reachability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inventory.ports.map((p) => (
                    <TableRow
                      key={`${p.protocol}:${p.address}:${p.port}:${p.process}`}
                    >
                      <TableCell>{p.protocol.toUpperCase()}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.address}
                      </TableCell>
                      <TableCell>{p.port}</TableCell>
                      <TableCell>{p.process || "Unknown"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        Unverified
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {!!inventory?.protections.length && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Installed protection</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tool</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Observation</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inventory.protections.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>{label(p.status)}</TableCell>
                      <TableCell className="whitespace-normal text-xs text-muted-foreground">
                        {p.detail}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {!!inventory?.firewalls.length && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Firewall evidence</h3>
              {inventory.firewalls.map((f) => (
                <details className="rounded-lg border px-4 py-3" key={f.name}>
                  <summary className="cursor-pointer text-sm">
                    {f.name} · {label(f.status)}
                  </summary>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                    {f.rules || "No rules reported."}
                  </pre>
                </details>
              ))}
            </div>
          )}
          {!!inventory?.containers.length && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Container inventory</h3>
              {inventory.containers.map((c) => (
                <details className="rounded-lg border px-4 py-3" key={c.id}>
                  <summary className="cursor-pointer text-sm">
                    {c.component} · User {c.user || "root (default)"}
                  </summary>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    <dt>Image ID</dt>
                    <dd className="break-all font-mono">{c.digest}</dd>
                    <dt>Container</dt>
                    <dd className="break-all font-mono">{c.id}</dd>
                    <dt>Networks</dt>
                    <dd className="break-all">
                      {c.networks.join(", ") || "None"}
                    </dd>
                    <dt>Published ports</dt>
                    <dd>{c.ports.join(", ") || "None"}</dd>
                    <dt>Added capabilities</dt>
                    <dd>{c.capabilities.join(", ") || "None"}</dd>
                    <dt>Host mount destinations</dt>
                    <dd>{c.mounts.join(", ") || "None"}</dd>
                  </dl>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
function PanelSecurity() {
  const { data, error, loading } = useSecurityData<{
    passkeys: unknown[];
    sessions: unknown[];
    recoveryCodesRemaining: number;
  }>("/security");
  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h3 className="font-medium">Control plane access</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Passkeys protect owner access. Sensitive changes require a fresh
          passkey verification.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loading && (
        <p className="text-sm text-muted-foreground">
          Loading account security…
        </p>
      )}
      {data && (
        <div className="grid gap-5 border-y py-5 sm:grid-cols-3">
          <Metric
            title="Registered passkeys"
            value={String(data.passkeys.length)}
            description={
              data.passkeys.length > 1
                ? "Backup sign-in method registered"
                : "Consider adding a backup passkey"
            }
          />
          <Metric
            title="Active sessions"
            value={String(data.sessions.length)}
            description="Review unfamiliar browsers"
          />
          <Metric
            title="Recovery codes"
            value={String(data.recoveryCodesRemaining)}
            description={
              data.recoveryCodesRemaining
                ? "Keep a copy offline"
                : "Generate recovery codes"
            }
          />
        </div>
      )}
      <Link
        className="text-sm underline underline-offset-4"
        to="/settings/security"
      >
        Manage passkeys, sessions and recovery
      </Link>
      <p className="text-xs text-muted-foreground">
        Account and sensitive panel actions appear in the Audit tab. Host checks
        apply to enrolled Linux machines; a Workers-hosted panel has no Linux
        host to inspect.
      </p>
    </div>
  );
}
function Retention({ days, changed }: { days: number; changed: () => void }) {
  const [value, setValue] = useState(String(days)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await signIn();
      await api("/security/settings", { retentionDays: Number(value) });
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save retention.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <h3 className="font-medium">Security history retention</h3>
      <p className="text-sm text-muted-foreground">
        Sets the security timeline window and retention for collected host
        events, resolved findings and older scans. Open findings and the latest
        scan are retained. Existing account and general activity logs keep their
        own storage policies.
      </p>
      <div className="flex gap-2">
        <Select
          aria-label="Security retention"
          value={value}
          onValueChange={setValue}
          options={[7, 30, 90, 180, 365].map((v) => ({
            value: String(v),
            label: `${v} days`,
          }))}
        />
        <Button onClick={save} disabled={busy || Number(value) === days}>
          {busy ? "Saving…" : "Save retention"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Metric({
  title,
  value,
  description,
}: {
  title: string;
  value: string;
  description: string;
}) {
  return (
    <div className="space-y-1 pr-4">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
