import {
  type ActivityList,
  type ActivityOutcome,
  activityCategories,
} from "@ephor/api/activity";
import {
  ArrowClockwiseIcon,
  ClockCounterClockwiseIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  UserCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { StatusIndicator } from "@/components/status-indicator";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
const outcomes: Record<
  ActivityOutcome,
  { label: string; tone: ComponentProps<typeof StatusIndicator>["tone"] }
> = {
  succeeded: { label: "Succeeded", tone: "healthy" },
  failed: { label: "Failed", tone: "error" },
  pending: { label: "Unconfirmed", tone: "busy" },
  unknown: { label: "Historical", tone: "neutral" },
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
  const activeFilters = [category, outcome, user, from || to].filter(
    Boolean,
  ).length;
  const filtered = !!(search || activeFilters);
  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A history of panel actions, who took them, and their outcomes.
          </p>
        </div>
        <Button
          variant="raised"
          size="action"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <ArrowClockwiseIcon
            aria-hidden="true"
            data-icon="inline-start"
            className={loading ? "animate-spin" : undefined}
          />
          Refresh
        </Button>
      </header>
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            variant="toolbar"
            aria-label="Search activity"
            className="pl-9"
            placeholder="Search activity…"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Popover>
          <PopoverTrigger
            render={
              <Button variant="raised" size="action" className="ml-auto" />
            }
          >
            <SlidersHorizontalIcon
              aria-hidden="true"
              data-icon="inline-start"
            />
            Filters
            {activeFilters > 0 && (
              <span className="flex size-5 items-center justify-center rounded-md bg-muted text-xs tabular-nums">
                {activeFilters}
                <span className="sr-only">active</span>
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label="Filter activity"
            className="w-80 gap-4"
          >
            <h2 className="font-medium">Filter activity</h2>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
              <span className="text-xs text-muted-foreground">Category</span>
              <Select
                aria-label="Filter by category"
                value={category}
                onValueChange={setCategory}
                options={[
                  { value: "", label: "All categories" },
                  ...activityCategories.map((value) => ({
                    value,
                    label: titleCase(value),
                  })),
                ]}
              />
              <span className="text-xs text-muted-foreground">User</span>
              <Select
                aria-label="Filter by user"
                value={user}
                onValueChange={setUser}
                options={[
                  { value: "", label: "All users" },
                  ...data.users.map((actor) => ({
                    value: actor.id,
                    label: actor.name,
                  })),
                ]}
              />
              <span className="text-xs text-muted-foreground">Outcome</span>
              <Select
                aria-label="Filter by outcome"
                value={outcome}
                onValueChange={setOutcome}
                options={[
                  { value: "", label: "All outcomes" },
                  ...Object.entries(outcomes).map(([value, info]) => ({
                    value,
                    label: info.label,
                  })),
                ]}
              />
              <span className="text-xs text-muted-foreground">From</span>
              <DatePicker
                label="From"
                value={from}
                max={to || undefined}
                onValueChange={setFrom}
              />
              <span className="text-xs text-muted-foreground">To</span>
              <DatePicker
                label="To"
                value={to}
                min={from || undefined}
                onValueChange={setTo}
              />
            </div>
          </PopoverContent>
        </Popover>
        {filtered && (
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Clear search and filters"
            title="Clear search and filters"
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
            <XIcon aria-hidden="true" />
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="space-y-4">
        <Table
          variant="layered"
          className="min-w-2xl table-fixed whitespace-nowrap [&_td]:px-3 [&_td]:py-2 [&_th]:px-3"
          aria-label="Panel activity history"
          aria-busy={loading || more}
        >
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Action</TableHead>
              <TableHead scope="col" className="w-[18%]">
                User
              </TableHead>
              <TableHead scope="col">Resource</TableHead>
              <TableHead scope="col" className="w-32">
                Outcome
              </TableHead>
              <TableHead scope="col" className="w-36 text-right">
                Time
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data.items.length && (
              <TableRow>
                <TableCell colSpan={5} className="h-48 text-center">
                  {loading ? (
                    <div
                      role="status"
                      className="flex items-center justify-center gap-2 text-muted-foreground"
                    >
                      <ArrowClockwiseIcon
                        aria-hidden="true"
                        className="size-4 animate-spin"
                      />
                      Loading activity…
                    </div>
                  ) : (
                    <>
                      <ClockCounterClockwiseIcon
                        aria-hidden="true"
                        className="mx-auto mb-3 size-7 text-muted-foreground"
                      />
                      <p className="font-medium">
                        {filtered ? "No matching activity" : "No activity yet"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {filtered
                          ? "Try another search or clear your filters."
                          : "Actions taken in the panel will appear here."}
                      </p>
                    </>
                  )}
                </TableCell>
              </TableRow>
            )}
            {data.items.map((item) => {
              const action = actionLabel(item.action);
              const occurredAt = new Date(item.occurredAt);
              const timestamp = occurredAt.toLocaleString(undefined, {
                dateStyle: "full",
                timeStyle: "long",
              });
              const resource =
                item.target.name ??
                item.target.id ??
                (item.target.type ? titleCase(item.target.type) : "—");
              return (
                <TableRow key={item.id} className={loading ? "opacity-50" : ""}>
                  <TableHead scope="row" className="py-2 text-foreground">
                    <div
                      className="flex min-w-0 items-center gap-2"
                      title={`${action} · ${titleCase(item.category)}`}
                    >
                      <ClockCounterClockwiseIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate text-sm font-medium">
                        {action}
                      </span>
                    </div>
                  </TableHead>
                  <TableCell>
                    <div
                      className="flex min-w-0 items-center gap-2"
                      title={`${item.actor.name} · ${
                        item.actor.id ??
                        (item.actor.kind === "unknown"
                          ? "User information was not stored for this historical entry."
                          : "No authenticated user was identified.")
                      }`}
                    >
                      <UserCircleIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate text-xs text-muted-foreground">
                        {item.actor.name}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div
                      className="flex min-w-0 items-center gap-2"
                      title={
                        [item.target.type, item.target.name, item.target.id]
                          .filter(Boolean)
                          .join(" · ") || undefined
                      }
                    >
                      {item.target.type === "service" && (
                        <CubeIcon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span
                        className={`truncate ${!item.target.name && item.target.id ? "font-mono text-xs text-muted-foreground" : ""}`}
                      >
                        {resource}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div
                      className="flex items-center"
                      title={
                        item.outcome === "pending"
                          ? "The request was recorded, but its final response was not confirmed."
                          : item.status
                            ? `HTTP ${item.status}`
                            : "The original audit log did not record an outcome."
                      }
                    >
                      <StatusIndicator
                        status={outcomes[item.outcome].label}
                        tone={outcomes[item.outcome].tone}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                    <time
                      className="block truncate"
                      dateTime={occurredAt.toISOString()}
                      title={timestamp}
                    >
                      <span aria-hidden="true">
                        {occurredAt.toLocaleString(undefined, {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="sr-only">{timestamp}</span>
                    </time>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className="text-xs tabular-nums text-muted-foreground"
            role="status"
          >
            {loading
              ? "Updating activity…"
              : `${data.items.length} ${data.items.length === 1 ? "entry" : "entries"} shown`}
          </p>
          {data.nextCursor && (
            <Button
              variant="raised"
              size="action"
              disabled={loading || more}
              onClick={() => void loadMore()}
            >
              {more && (
                <ArrowClockwiseIcon
                  aria-hidden="true"
                  className="animate-spin"
                />
              )}
              {more ? "Loading…" : "Load older activity"}
            </Button>
          )}
        </div>
        {data.items.some((item) => item.actor.kind === "unknown") && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Historical entries come from the previous audit log, which did not
            record the acting user or request outcome.
          </p>
        )}
      </div>
    </div>
  );
}
