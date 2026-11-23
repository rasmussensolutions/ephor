import type { SecurityAction, SecurityActionList } from "@ephor/api/security";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSecurityData, when } from "./security-data";
import { SecurityFindings } from "./security-findings";

export function actionTitle(action: SecurityAction) {
  if (action.fixesAvailable) return "Review image updates";
  if (action.advisoryCount) return "Review package advisories";
  return "Review configuration";
}
export function actionNextStep(action: SecurityAction) {
  if (action.fixesAvailable)
    return "Review the reported fixed versions, update the affected image or dependencies, redeploy, then scan again to verify. A compatible replacement image has not been verified.";
  if (action.advisoryCount)
    return "No fixed package version was reported. Review the advisories and affected code paths; runtime exploitability has not been assessed.";
  return "Open the configuration findings for their evidence and recommended changes.";
}
export function ActionSummary({ action: a }: { action: SecurityAction }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        {a.count} finding instances · {a.advisoryCount} distinct package
        advisories
        {a.configurationCount
          ? ` · ${a.configurationCount} configuration checks`
          : ""}
      </p>
      {!!a.advisoryCount && (
        <>
          <p>
            {a.layers.os} OS package findings · {a.layers.language} language
            package findings · {a.layers.other} other artifact findings
          </p>
          <p>
            {a.fixesAvailable} with a reported fix · {a.noFixReported} without a
            reported fix
          </p>
        </>
      )}
    </div>
  );
}

export function SecurityActions({
  scope,
  initialFinding,
  onChange,
}: {
  scope: string;
  initialFinding?: string;
  onChange: () => void;
}) {
  const [view, setView] = useState(initialFinding ? "individual" : "actions");
  const [resource, setResource] = useState("");
  const [workload, setWorkload] = useState("active");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (initialFinding) setView("individual");
  }, [initialFinding]);
  const params = new URLSearchParams(scope);
  params.set("workload", workload);
  params.set("status", status);
  if (search) params.set("q", search);
  const filter = params.toString();
  // Reset pagination and selected resource when the workspace/filter changes.
  const [previousFilter, setPreviousFilter] = useState(filter);
  if (previousFilter !== filter) {
    setPreviousFilter(filter);
    setCursors([]);
    setResource("");
  }
  const current = cursors.at(-1);
  if (current) params.set("before", current);
  const { data, loading, error, refresh } = useSecurityData<SecurityActionList>(
    `/security/actions?${params}`,
  );
  const individualParams = new URLSearchParams(filter);
  if (resource) individualParams.set("resource", resource);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Security findings view"
          value={view}
          onValueChange={(v) => {
            setView(v);
            setResource("");
          }}
          options={[
            { value: "actions", label: "Grouped actions" },
            { value: "individual", label: "Individual findings" },
          ]}
        />
        <Select
          aria-label="Workload state"
          value={workload}
          onValueChange={setWorkload}
          options={[
            { value: "active", label: "Active workloads" },
            { value: "stopped", label: "Stopped / disconnected" },
            { value: "all", label: "All workloads" },
          ]}
        />
        {view === "actions" && (
          <>
            <Input
              aria-label="Search security actions"
              placeholder="Search services, packages or CVEs…"
              className="max-w-sm"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select
              aria-label="Action finding status"
              value={status}
              onValueChange={setStatus}
              options={[
                { value: "active", label: "Needs attention" },
                { value: "accepted", label: "Risk accepted" },
                { value: "resolved", label: "Resolved" },
                { value: "all", label: "All statuses" },
              ]}
            />
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => {
                refresh();
                onChange();
              }}
            >
              Refresh
            </Button>
          </>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Package matches identify affected versions, not confirmed exploits.
        Language packages may belong to your app or bundled tooling; ownership
        and runtime reachability are not yet assessed. Stopped workloads remain
        available in the filter.
      </p>
      {view === "individual" ? (
        <>
          {resource && (
            <Button
              variant="outline"
              onClick={() => {
                setResource("");
                setView("actions");
              }}
            >
              Back to grouped actions
            </Button>
          )}
          <SecurityFindings
            key={individualParams.toString()}
            scope={individualParams.toString()}
            initialFinding={initialFinding}
            onChange={() => {
              refresh();
              onChange();
            }}
          />
        </>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource / action</TableHead>
                <TableHead>Advisory severity</TableHead>
                <TableHead>Last observed</TableHead>
                <TableHead>
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((a) => (
                <TableRow key={a.target}>
                  <TableCell className="max-w-2xl whitespace-normal py-4">
                    <p className="font-medium">
                      {a.serviceName ?? a.machineName}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {a.serviceName ? `${a.machineName} · ` : ""}
                      {a.stopped
                        ? "Stopped / disconnected · retained findings"
                        : "Active workload · last observed findings"}
                      {a.imageCount
                        ? ` · ${a.imageCount} image${a.imageCount === 1 ? "" : "s"}`
                        : ""}
                    </p>
                    <p className="mt-3 font-medium">{actionTitle(a)}</p>
                    <div className="mt-2">
                      <ActionSummary action={a} />
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {actionNextStep(a)}
                    </p>
                  </TableCell>
                  <TableCell className="align-top pt-4 text-xs">
                    <p>
                      {a.counts.critical} critical · {a.counts.high} high
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {a.counts.medium} medium · {a.counts.low} low ·{" "}
                      {a.counts.info} info
                    </p>
                  </TableCell>
                  <TableCell className="align-top pt-4 text-xs text-muted-foreground">
                    {when(a.lastSeen)}
                  </TableCell>
                  <TableCell className="align-top pt-4">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setResource(a.target);
                        setView("individual");
                      }}
                    >
                      View findings
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!data?.items.length && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="py-12 text-center text-muted-foreground"
                  >
                    {loading
                      ? "Loading grouped actions…"
                      : "No matching actions. Check Coverage for missing or stale scans."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex gap-2">
            {!!cursors.length && (
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => setCursors((v) => v.slice(0, -1))}
              >
                Previous
              </Button>
            )}
            {data?.nextCursor && (
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => {
                  const next = data.nextCursor;
                  if (next) setCursors((v) => [...v, next]);
                }}
              >
                Next resources
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
