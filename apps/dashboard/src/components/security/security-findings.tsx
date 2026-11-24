import {
  type FindingList,
  type SecurityFinding,
  type Severity,
  severities,
} from "@ephor/api/security";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, reauthenticate } from "@/lib/auth";
import { SecurityAudit } from "./security-audit";
import { label, when } from "./security-data";

export function SeverityBadge({ severity }: { severity: Severity }) {
  const colors = {
    critical: "text-red-700 bg-red-500/10 dark:text-red-300",
    high: "text-orange-700 bg-orange-500/10 dark:text-orange-300",
    medium: "text-amber-700 bg-amber-500/10 dark:text-amber-300",
    low: "text-muted-foreground bg-muted",
    info: "text-muted-foreground bg-muted",
  };
  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${colors[severity]}`}
    >
      {label(severity)}
    </span>
  );
}
export function SecurityFindings({
  scope,
  initialFinding,
  onChange,
}: {
  scope: string;
  initialFinding?: string;
  onChange: () => void;
}) {
  const [query, setQuery] = useState(
      () => new URLSearchParams(scope).get("q") ?? "",
    ),
    [severity, setSeverity] = useState(""),
    [category, setCategory] = useState("");
  const [status, setStatus] = useState(
      () => new URLSearchParams(scope).get("status") ?? "active",
    ),
    [data, setData] = useState<FindingList | null>(null),
    [selected, setSelected] = useState<SecurityFinding | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const previousFilter = useRef("");
  useEffect(() => {
    if ((data?.items.length ?? 0) > 100) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRevision((v) => v + 1);
    }, 30000);
    return () => clearInterval(timer);
  }, [data?.items.length]);
  const params = new URLSearchParams(scope);
  params.set("status", status);
  params.delete("q");
  if (query) params.set("q", query);
  if (severity) params.set("severity", severity);
  if (category) params.set("category", category);
  const filter = params.toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision reloads findings after an explicit refresh or review.
  useEffect(() => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    if (previousFilter.current !== filter) setData(null);
    previousFilter.current = filter;
    const timer = setTimeout(() => {
      void api<FindingList>(`/security/findings?${filter}`)
        .then((next) => {
          if (generation.current === current) setData(next);
        })
        .catch(() => {
          if (generation.current === current)
            setError("Could not load findings.");
        })
        .finally(() => {
          if (generation.current === current) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [filter, revision]);
  useEffect(() => {
    if (!initialFinding) return;
    let alive = true;
    void api<FindingList>(
      `/security/findings?status=all&id=${encodeURIComponent(initialFinding)}`,
    )
      .then((result) => {
        if (alive) setSelected(result.items[0] ?? null);
      })
      .catch(() => {
        if (alive) setError("Could not load the linked finding.");
      });
    return () => {
      alive = false;
    };
  }, [initialFinding]);
  async function more() {
    if (!data?.nextCursor) return;
    const current = generation.current;
    setBusy(true);
    try {
      const next = await api<FindingList>(
        `/security/findings?${filter}&before=${encodeURIComponent(data.nextCursor)}`,
      );
      if (generation.current === current)
        setData((old) => ({
          items: [...(old?.items ?? []), ...next.items],
          nextCursor: next.nextCursor,
        }));
    } catch {
      setError("Could not load more findings.");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search findings"
          placeholder="Search findings…"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <Select
          aria-label="Finding severity"
          value={severity}
          onValueChange={setSeverity}
          options={[
            { value: "", label: "All severities" },
            ...severities.map((s) => ({ value: s, label: label(s) })),
          ]}
        />
        <Select
          aria-label="Finding category"
          value={category}
          onValueChange={setCategory}
          options={[
            { value: "", label: "All categories" },
            ...[
              "vulnerability",
              "ssh",
              "network",
              "maintenance",
              "container",
              "coverage",
            ].map((s) => ({ value: s, label: label(s) })),
          ]}
        />
        <Select
          aria-label="Finding status"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: "active", label: "Needs attention" },
            { value: "all", label: "All statuses" },
            { value: "open", label: "Open" },
            { value: "acknowledged", label: "Acknowledged" },
            { value: "accepted", label: "Risk accepted" },
            { value: "resolved", label: "Resolved" },
          ]}
        />
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setRevision((v) => v + 1);
            onChange();
          }}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Advisory / check severity</TableHead>
            <TableHead>Finding</TableHead>
            <TableHead>Affected resource</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data?.items.map((f) => (
            <TableRow key={f.id}>
              <TableCell>
                <SeverityBadge severity={f.severity} />
              </TableCell>
              <TableCell className="max-w-md whitespace-normal">
                <button
                  type="button"
                  className="text-left font-medium hover:underline focus-visible:underline"
                  onClick={() => setSelected(f)}
                >
                  {f.title}
                </button>
                <div className="mt-1 text-xs text-muted-foreground">
                  {label(f.category)}
                  {f.component ? ` · ${f.component}` : ""}
                </div>
                {f.detail && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {f.evidence}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <div>{f.serviceName ?? f.machineName}</div>
                {f.serviceName && (
                  <div className="text-xs text-muted-foreground">
                    {f.machineName}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {f.status === "accepted" ? "Risk accepted" : label(f.status)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {when(f.lastSeen)}
              </TableCell>
            </TableRow>
          ))}
          {!data?.items.length && (
            <TableRow>
              <TableCell
                colSpan={5}
                className="py-12 text-center text-muted-foreground"
              >
                {busy
                  ? "Loading findings…"
                  : "No findings match these filters. Check coverage to see what has been inspected."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data?.nextCursor && (
        <Button variant="outline" onClick={more} disabled={busy}>
          Load more findings
        </Button>
      )}
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          {selected && (
            <FindingDetails
              key={selected.id}
              finding={selected}
              changed={() => {
                setRevision((v) => v + 1);
                onChange();
                setSelected(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
function FindingDetails({
  finding: f,
  changed,
}: {
  finding: SecurityFinding;
  changed: () => void;
}) {
  const [action, setAction] = useState(
      f.status === "resolved" ? "open" : f.status,
    ),
    [reason, setReason] = useState(f.reason ?? ""),
    [expiry, setExpiry] = useState(() => {
      if (!f.acceptedUntil) return "";
      const date = new Date(f.acceptedUntil);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inputId = useId();
  async function save() {
    setBusy(true);
    setError("");
    try {
      await reauthenticate();
      await api(`/security/findings/${f.id}`, {
        status: action,
        reason,
        acceptedUntil: expiry ? new Date(`${expiry}T23:59:59`).getTime() : null,
      });
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update finding.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SheetHeader>
        <div>
          <SeverityBadge severity={f.severity} />
        </div>
        <SheetTitle>{f.title}</SheetTitle>
        <SheetDescription>
          {f.serviceName ? `${f.serviceName} on ` : ""}
          {f.machineName}
          {f.component ? ` · ${f.component}` : ""}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-6 px-6 pb-6 text-sm">
        <div className="space-y-2">
          <h3 className="font-medium">Evidence</h3>
          <p className="whitespace-pre-wrap break-words text-muted-foreground">
            {f.evidence}
          </p>
        </div>
        {f.detail && (
          <p className="text-sm text-muted-foreground">
            This is a package-version match inside the image. The scanner has
            not verified whether this application's running code can trigger the
            vulnerability. The advisory severity is preserved.
          </p>
        )}
        <div className="space-y-2">
          <h3 className="font-medium">Recommended action</h3>
          <p className="text-muted-foreground">{f.remediation}</p>
        </div>
        {f.detail && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt>Package</dt>
            <dd className="break-all">{f.detail.package}</dd>
            <dt>Installed</dt>
            <dd>{f.detail.installedVersion}</dd>
            <dt>Fixed version</dt>
            <dd>{f.detail.fixedVersion || "No fix reported"}</dd>
            <dt>Artifact</dt>
            <dd className="break-all">{f.detail.target}</dd>
            <dt>Image ID</dt>
            <dd className="break-all font-mono">{f.detail.digest}</dd>
          </dl>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <dt>First seen</dt>
          <dd>{when(f.firstSeen)}</dd>
          <dt>Last seen</dt>
          <dd>{when(f.lastSeen)}</dd>
          {f.resolvedAt && (
            <>
              <dt>Verified resolved</dt>
              <dd>{when(f.resolvedAt)}</dd>
            </>
          )}
          {f.acceptedUntil && (
            <>
              <dt>Risk acceptance expires</dt>
              <dd>{when(f.acceptedUntil)}</dd>
            </>
          )}
        </dl>
        <div className="flex gap-4">
          <Link
            className="underline underline-offset-4"
            to="/machines/$machineId"
            params={{ machineId: f.machineId }}
          >
            View machine
          </Link>
          {f.serviceId && (
            <Link
              className="underline underline-offset-4"
              to="/services/$serviceId"
              params={{ serviceId: f.serviceId }}
            >
              View service
            </Link>
          )}
        </div>
        {f.status !== "resolved" && (
          <div className="space-y-3 border-t pt-5">
            <h3 className="font-medium">Review finding</h3>
            <Select
              aria-label="Update finding status"
              value={action}
              onValueChange={(v) => setAction(v as typeof action)}
              options={[
                { value: "open", label: "Open" },
                { value: "acknowledged", label: "Acknowledged" },
                { value: "accepted", label: "Accept risk" },
              ]}
            />
            {action === "accepted" && (
              <>
                <label
                  htmlFor={`${inputId}-reason`}
                  className="block space-y-1"
                >
                  <span>Reason</span>
                  <Input
                    id={`${inputId}-reason`}
                    value={reason}
                    maxLength={1000}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this risk acceptable?"
                  />
                </label>
                <label
                  htmlFor={`${inputId}-expiry`}
                  className="block space-y-1"
                >
                  <span>Expiry date (optional)</span>
                  <Input
                    id={`${inputId}-expiry`}
                    type="date"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  />
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <Button
              onClick={save}
              disabled={busy || (action === "accepted" && !reason.trim())}
            >
              {busy ? "Saving…" : "Save review"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Findings resolve automatically when a successful scan verifies the
              issue is gone.
            </p>
          </div>
        )}
        <div className="space-y-3 border-t pt-5">
          <h3 className="font-medium">Finding history</h3>
          <SecurityAudit scope="" finding={f.id} />
        </div>
      </div>
    </>
  );
}
