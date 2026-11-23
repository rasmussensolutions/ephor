import type { SecurityEventList } from "@ephor/api/security";
import { useEffect, useId, useRef, useState } from "react";
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
import { api } from "@/lib/auth";
import { label, when } from "./security-data";

export function SecurityAudit({
  scope,
  finding,
}: {
  scope: string;
  finding?: string;
}) {
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("");
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [data, setData] = useState<SecurityEventList | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const previousFilter = useRef("");
  useEffect(() => {
    if ((data?.items.length ?? 0) > 100) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRefresh((v) => v + 1);
    }, 30000);
    return () => clearInterval(timer);
  }, [data?.items.length]);
  const inputId = useId();
  const params = new URLSearchParams(scope);
  if (finding) params.set("finding", finding);
  if (query) params.set("q", query);
  if (kind) params.set("kind", kind);
  if (from) params.set("from", String(new Date(`${from}T00:00:00`).getTime()));
  if (to) {
    const date = new Date(`${to}T00:00:00`);
    date.setDate(date.getDate() + 1);
    params.set("to", String(date.getTime()));
  }
  const filter = params.toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly reloads the current filters.
  useEffect(() => {
    const current = ++generation.current;
    setBusy(true);
    if (previousFilter.current !== filter) setData(null);
    previousFilter.current = filter;
    setError("");
    const timer = setTimeout(() => {
      void api<SecurityEventList>(`/security/audit?${filter}`)
        .then((result) => {
          if (current === generation.current) setData(result);
        })
        .catch(() => {
          if (current === generation.current)
            setError("Could not load the security timeline.");
        })
        .finally(() => {
          if (current === generation.current) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [filter, refresh]);
  async function more() {
    if (!data?.nextCursor) return;
    const current = generation.current;
    setBusy(true);
    try {
      const next = await api<SecurityEventList>(
        `/security/audit?${filter}&before=${encodeURIComponent(data.nextCursor)}`,
      );
      if (current === generation.current)
        setData((old) => ({
          items: [...(old?.items ?? []), ...next.items],
          nextCursor: next.nextCursor,
        }));
    } catch {
      setError("Could not load more events.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function download() {
    setExporting(true);
    setError("");
    try {
      const items: SecurityEventList["items"] = [];
      let cursor: string | null = null;
      // Export bounded pages without silently dropping later events.
      do {
        const page: SecurityEventList = await api(
          `/security/export?${filter}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        if (items.length > 100000)
          throw new Error(
            "Narrow the date range to export fewer than 100,000 events.",
          );
      } while (cursor);
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                exportedAt: new Date().toISOString(),
                filters: Object.fromEntries(new URLSearchParams(filter)),
                events: items,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "ephor-security-audit.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="space-y-4">
      {!finding && (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="Search security events"
            placeholder="Search events, users or addresses…"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-sm"
          />
          <Select
            aria-label="Event type"
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "", label: "All events" },
              ...[
                "panel",
                "account",
                "protection",
                "ssh.accepted",
                "ssh.rejected",
                "ssh.closed",
                "collection.gap",
                "scan",
                "finding.new",
                "finding.resolved",
                "finding.status",
              ].map((v) => ({ value: v, label: label(v) })),
            ]}
          />
          <label
            htmlFor={`${inputId}-from`}
            className="text-xs text-muted-foreground"
          >
            From
            <Input
              id={`${inputId}-from`}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label
            htmlFor={`${inputId}-to`}
            className="text-xs text-muted-foreground"
          >
            Through
            <Input
              id={`${inputId}-to`}
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            onClick={() => setRefresh((v) => v + 1)}
            disabled={busy}
          >
            Refresh
          </Button>
          <Button variant="outline" onClick={download} disabled={exporting}>
            {exporting ? "Exporting…" : "Export JSON"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data?.items.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="max-w-lg whitespace-normal">
                <div className="font-medium">{label(event.action)}</div>
                {event.detail && (
                  <div className="mt-1 text-xs text-muted-foreground break-words">
                    {event.detail}
                  </div>
                )}
              </TableCell>
              <TableCell>{event.actor}</TableCell>
              <TableCell>{label(event.outcome)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {when(event.occurredAt)}
              </TableCell>
            </TableRow>
          ))}
          {!data?.items.length && (
            <TableRow>
              <TableCell
                colSpan={4}
                className="py-10 text-center text-muted-foreground"
              >
                {busy
                  ? "Loading security events…"
                  : "No security events match these filters."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data?.nextCursor && (
        <Button variant="outline" onClick={more} disabled={busy}>
          Load more events
        </Button>
      )}
      {!finding && (
        <p className="text-xs text-muted-foreground">
          Host events use the machine’s clock. Collection gaps are recorded
          explicitly. Historical account records may not include an actor or
          outcome.
        </p>
      )}
    </div>
  );
}
