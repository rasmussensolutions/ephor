import {
  type ActivityList,
  type ActivityOutcome,
  activityCategories,
} from "@ephor/api/activity";
import {
  ArrowClockwiseIcon,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
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

export const Route = createFileRoute("/_authenticated/activity")({
  head: () => ({ meta: [{ title: "Activity — Ephor" }] }),
  loader: () => api<ActivityList>("/activity"),
  component: ActivityPage,
});
const outcomes: Record<ActivityOutcome, { label: string; className: string }> =
  {
    succeeded: {
      label: "Succeeded",
      className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    },
    failed: {
      label: "Failed",
      className: "bg-destructive/10 text-destructive",
    },
    pending: {
      label: "Unconfirmed",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    },
    unknown: {
      label: "Historical",
      className: "bg-muted text-muted-foreground",
    },
  };
const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
function actionLabel(action: string) {
  return action.includes(".")
    ? titleCase(action.replace(/[._]/g, " "))
    : action;
}
function ActivityPage() {
  const initial = Route.useLoaderData();
  const [data, setData] = useState(initial);
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState("");
  const [category, setCategory] = useState(""),
    [outcome, setOutcome] = useState("");
  const [user, setUser] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [more, setMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  if (outcome) params.set("outcome", outcome);
  if (user) params.set("user", user);
  if (from) params.set("from", String(new Date(`${from}T00:00:00`).getTime()));
  if (to) {
    const end = new Date(`${to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    params.set("to", String(end.getTime()));
  }
  const filters = params.toString();
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly reloads the current filters.
  useEffect(() => {
    // A new filter/refresh invalidates both older page and load-more requests.
    const current = ++generation.current;
    let alive = true;
    setLoading(true);
    setMore(false);
    setError("");
    void api<ActivityList>(`/activity?${filters}`)
      .then((next) => {
        if (alive && current === generation.current) setData(next);
      })
      .catch(() => {
        if (alive) setError("Could not load activity. Try refreshing.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      generation.current++;
    };
  }, [filters, refresh]);
  async function loadMore() {
    if (!data.nextCursor || loading || more) return;
    const current = generation.current;
    setMore(true);
    setError("");
    try {
      const next = await api<ActivityList>(
        `/activity?${filters}&before=${encodeURIComponent(data.nextCursor)}`,
      );
      if (current === generation.current)
        setData((old) => ({
          ...next,
          items: [
            ...old.items,
            ...next.items.filter(
              (item) => !old.items.some((previous) => previous.id === item.id),
            ),
          ],
        }));
    } catch {
      if (current === generation.current)
        setError("Could not load older activity. Try again.");
    } finally {
      if (current === generation.current) setMore(false);
    }
  }
  const filtered = !!(search || category || outcome || user || from || to);
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every panel action, with who did it and when.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <ArrowClockwiseIcon className={loading ? "animate-spin" : ""} />{" "}
          Refresh
        </Button>
      </header>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-56 flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              aria-label="Search activity"
              className="h-9 pl-9"
              placeholder="Search actions, users, or resources…"
              maxLength={200}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select
            aria-label="Filter by category"
            value={category}
            onValueChange={(next) => setCategory(next)}
            options={[
              { value: "", label: "All categories" },
              ...activityCategories.map((value) => ({
                value,
                label: titleCase(value),
              })),
            ]}
          />
          <Select
            aria-label="Filter by user"
            value={user}
            onValueChange={(next) => setUser(next)}
            options={[
              { value: "", label: "All users" },
              ...data.users.map((actor) => ({
                value: actor.id,
                label: actor.name,
              })),
            ]}
          />
          <Select
            aria-label="Filter by outcome"
            value={outcome}
            onValueChange={(next) => setOutcome(next)}
            options={[
              { value: "", label: "All outcomes" },
              ...Object.entries(outcomes).map(([value, info]) => ({
                value,
                label: info.label,
              })),
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>From</span>
            <DatePicker
              label="From"
              value={from}
              max={to || undefined}
              onValueChange={setFrom}
            />
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>To</span>
            <DatePicker
              label="To"
              value={to}
              min={from || undefined}
              onValueChange={setTo}
            />
          </div>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setQuery("");
                setCategory("");
                setOutcome("");
                setUser("");
                setFrom("");
                setTo("");
              }}
            >
              Clear filters
            </Button>
          )}
          <p className="ml-auto text-xs text-muted-foreground" role="status">
            {loading
              ? "Loading activity…"
              : `${data.items.length} ${data.items.length === 1 ? "entry" : "entries"} shown`}
          </p>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {data.items.some((item) => item.actor.kind === "unknown") && (
        <p className="text-xs text-muted-foreground">
          Historical entries come from the previous audit log, which did not
          record the acting user or request outcome.
        </p>
      )}
      <Table aria-label="Panel activity history" aria-busy={loading || more}>
        <TableHeader>
          <TableRow>
            <TableHead>Action</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Resource</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!loading && !data.items.length && (
            <TableRow>
              <TableCell colSpan={5} className="py-16 text-center">
                <ClockCounterClockwiseIcon className="mx-auto mb-3 size-7 text-muted-foreground" />
                <p className="font-medium">
                  {filtered ? "No matching activity" : "No activity yet"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {filtered
                    ? "Try another search or clear your filters."
                    : "Actions taken in the panel will appear here."}
                </p>
              </TableCell>
            </TableRow>
          )}
          {data.items.map((item) => (
            <TableRow key={item.id} className={loading ? "opacity-50" : ""}>
              <TableCell className="min-w-52">
                <p className="font-medium">{actionLabel(item.action)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {titleCase(item.category)}
                </p>
              </TableCell>
              <TableCell>
                <div
                  className="flex items-center gap-2"
                  title={
                    item.actor.id ??
                    (item.actor.kind === "unknown"
                      ? "User information was not stored for this historical entry."
                      : "No authenticated user was identified.")
                  }
                >
                  <UserCircleIcon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="max-w-48 truncate">{item.actor.name}</span>
                </div>
              </TableCell>
              <TableCell className="max-w-64">
                <p
                  className="truncate"
                  title={item.target.name ?? item.target.id ?? undefined}
                >
                  {item.target.name ??
                    (item.target.type ? titleCase(item.target.type) : "—")}
                </p>
                {item.target.id && (
                  <p
                    className="mt-1 truncate font-mono text-xs text-muted-foreground"
                    title={item.target.id}
                  >
                    {item.target.id}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <span
                  className={`inline-flex whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium ${outcomes[item.outcome].className}`}
                  title={
                    item.outcome === "pending"
                      ? "The request was recorded, but its final response was not confirmed."
                      : item.status
                        ? `HTTP ${item.status}`
                        : "The original audit log did not record an outcome."
                  }
                >
                  {outcomes[item.outcome].label}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                <time dateTime={new Date(item.occurredAt).toISOString()}>
                  {new Date(item.occurredAt).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                  <span className="mt-1 block">
                    {new Date(item.occurredAt).toLocaleTimeString()}
                  </span>
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Outcomes describe the panel request. Deployments, updates, and backups
          continue in the background. Times are shown in your local timezone.
        </p>
        {data.nextCursor && (
          <Button
            variant="outline"
            disabled={loading || more}
            onClick={() => void loadMore()}
          >
            {more ? "Loading…" : "Load older activity"}
          </Button>
        )}
      </div>
    </div>
  );
}
