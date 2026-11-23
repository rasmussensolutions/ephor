import { Tabs } from "@base-ui/react/tabs";
import type { NotificationList } from "@ephor/api/notifications";
import {
  ArrowClockwiseIcon,
  ChecksIcon,
  GearSixIcon,
} from "@phosphor-icons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { NotificationsTable } from "@/components/notifications/notifications-table";
import { Button, buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/notifications")({
  loader: () => api<NotificationList>("/notifications"),
  component: NotificationsPage,
});

const notificationViews = [
  { value: "inbox", label: "Inbox" },
  { value: "history", label: "Delivery history" },
] as const;

function NotificationsPage() {
  const initial = Route.useLoaderData();
  const [data, setData] = useState(initial),
    [mode, setMode] = useState<"inbox" | "history">("inbox");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const activeMode = useRef(mode);
  useEffect(() => {
    activeMode.current = mode;
    let alive = true;
    setLoading(true);
    async function refresh() {
      try {
        const next = await api<NotificationList>(`/notifications?view=${mode}`);
        if (alive) {
          setData((old) =>
            old.items.length > 100
              ? {
                  ...next,
                  nextCursor: old.nextCursor,
                  items: [
                    ...next.items,
                    ...old.items.filter(
                      (item) =>
                        !next.items.some((current) => current.id === item.id),
                    ),
                  ],
                }
              : next,
          );
          setError("");
        }
      } catch {
        if (alive)
          setError("Could not refresh notifications. Try again shortly.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [mode]);
  async function markRead(id: string) {
    setBusy(true);
    setError("");
    try {
      await api("/notifications/read", { id });
      setData(await api<NotificationList>(`/notifications?view=${mode}`));
      window.dispatchEvent(new Event("ephor-notifications-changed"));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not mark notification as read.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function loadMore() {
    if (!data.nextCursor) return;
    const view = mode;
    setBusy(true);
    try {
      const next = await api<NotificationList>(
        `/notifications?view=${mode}&before=${encodeURIComponent(data.nextCursor)}`,
      );
      if (activeMode.current === view)
        setData((old) => ({
          ...next,
          items: [
            ...old.items,
            ...next.items.filter((n) => !old.items.some((o) => o.id === n.id)),
          ],
        }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Tabs.Root
      value={mode}
      onValueChange={(value) => {
        if ((value === "inbox" || value === "history") && value !== mode) {
          setMode(value);
          setData({ ...initial, items: [] });
        }
      }}
      className="min-w-0 space-y-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Updates about your machines, deployments, and backups.
          </p>
        </div>
        <Link
          to="/settings/notifications"
          className={buttonVariants({ variant: "raised", size: "action" })}
        >
          <GearSixIcon aria-hidden="true" data-icon="inline-start" />
          Notification settings
        </Link>
      </header>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <Tabs.List
          className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1"
          aria-label="Notification view"
        >
          {notificationViews.map((view) => (
            <Tabs.Tab
              key={view.value}
              value={view.value}
              className="shrink-0 rounded-md px-3 py-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-active:bg-card data-active:text-foreground"
            >
              {view.label}
              {view.value === "inbox" && data.unread > 0 && (
                <span className="ml-1 tabular-nums text-muted-foreground">
                  {data.unread}
                  <span className="sr-only"> unread</span>
                </span>
              )}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {mode === "inbox" && data.unread > 0 && (
          <Button
            variant="raised"
            size="action"
            disabled={busy || loading}
            onClick={() => void markRead("all")}
          >
            <ChecksIcon aria-hidden="true" data-icon="inline-start" />
            Mark all read
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
      {(!data.lastRun || Date.now() - data.lastRun > 5 * 60000) && (
        <p
          role="status"
          className="rounded-lg border p-3 text-sm text-muted-foreground"
        >
          {data.lastRun
            ? "Notification processing has not checked in recently. Alerts may be delayed. Check the panel’s background worker or cron."
            : "Waiting for the notification processor’s first check. This normally takes up to one minute."}
        </p>
      )}
      {notificationViews.map((view) => (
        <Tabs.Panel
          key={view.value}
          value={view.value}
          className="space-y-4 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <NotificationsTable
            items={data.items}
            mode={view.value}
            loading={loading}
            busy={busy}
            onMarkRead={(id) => void markRead(id)}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p
              className="text-xs tabular-nums text-muted-foreground"
              role="status"
            >
              {loading
                ? "Updating notifications…"
                : `${data.items.length} ${data.items.length === 1 ? "notification" : "notifications"} shown`}
            </p>
            {data.nextCursor && (
              <Button
                variant="raised"
                size="action"
                disabled={busy || loading}
                onClick={() => void loadMore()}
              >
                {busy && (
                  <ArrowClockwiseIcon
                    aria-hidden="true"
                    className="animate-spin"
                  />
                )}
                {busy ? "Loading…" : "Load older notifications"}
              </Button>
            )}
          </div>
          {view.value === "history" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              History is kept for 90 days. “Accepted by Resend” confirms
              submission, not delivery to an inbox. Check Resend for bounces and
              delivery details.
            </p>
          )}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
