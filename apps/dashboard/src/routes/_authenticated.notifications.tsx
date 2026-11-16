import type { NotificationList } from "@ephor/api/notifications";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/notifications")({
  loader: () => api<NotificationList>("/notifications"),
  component: NotificationsPage,
});
const deliveryLabels: Record<string, string> = {
  queued: "Queued for email",
  sending: "Sending email",
  sent: "Accepted by Resend",
  failed: "Email failed",
  uncertain: "Email delivery uncertain",
  cancelled: "Email cancelled",
  skipped: "Email not selected",
};
const deliveryErrors: Record<string, string> = {
  EMAIL_DISABLED: "Email was disabled before this notification was sent.",
  RESEND_ACCESS_DENIED:
    "Resend rejected access. Check the API key, sending domain, and its permissions.",
  RESEND_REJECTED:
    "Resend rejected the message. Check the sender, recipients, verified domain, and account limits.",
  RESEND_RATE_LIMITED:
    "Resend is rate limiting requests. Ephor will retry within the delivery window.",
  RESEND_UNAVAILABLE:
    "Resend could not be reached reliably. Ephor will retry within the delivery window.",
  DELIVERY_RETRIES_EXHAUSTED:
    "Automatic retries stopped. The email may have been accepted; inspect Resend before sending another test.",
  DELIVERY_WINDOW_EXPIRED:
    "The safe retry window expired. The email may have been accepted; inspect Resend before sending another test.",
};
function NotificationsPage() {
  const initial = Route.useLoaderData();
  const [data, setData] = useState(initial),
    [mode, setMode] = useState<"inbox" | "history">("inbox");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const activeMode = useRef(mode);
  useEffect(() => {
    activeMode.current = mode;
    let alive = true;
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
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Updates about your machines, deployments, and backups.
          </p>
        </div>
        <Link
          to="/settings/notifications"
          className={buttonVariants({ variant: "outline" })}
        >
          Notification settings
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={mode === "inbox" ? "default" : "outline"}
          aria-pressed={mode === "inbox"}
          onClick={() => {
            if (mode !== "inbox") {
              setMode("inbox");
              setData({ ...initial, items: [] });
            }
          }}
        >
          Inbox{data.unread ? ` · ${data.unread} unread` : ""}
        </Button>
        <Button
          variant={mode === "history" ? "default" : "outline"}
          aria-pressed={mode === "history"}
          onClick={() => {
            if (mode !== "history") {
              setMode("history");
              setData({ ...initial, items: [] });
            }
          }}
        >
          Delivery history
        </Button>
        {mode === "inbox" && data.unread > 0 && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void markRead("all")}
          >
            Mark all read
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {(!data.lastRun || Date.now() - data.lastRun > 5 * 60000) && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {data.lastRun
            ? "Notification processing has not checked in recently. Alerts may be delayed. Check the panel’s background worker or cron."
            : "Waiting for the notification processor’s first check. This normally takes up to one minute."}
        </p>
      )}
      {mode === "history" && (
        <p className="text-sm text-muted-foreground">
          History is kept for 90 days. “Accepted by Resend” confirms submission,
          not delivery to an inbox. Check Resend for bounces and delivery
          details.
        </p>
      )}
      <div className="divide-y rounded-xl border bg-card">
        {!data.items.length && (
          <div className="p-8 text-center">
            <h2 className="font-medium">
              {mode === "inbox" ? "You’re all caught up" : "No deliveries yet"}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose what to receive in notification settings, or send a test.
            </p>
          </div>
        )}
        {data.items.map((n) => (
          <article key={n.id} className="space-y-3 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words font-medium">
                  {mode === "inbox" && !n.read_at && (
                    <span
                      className="mr-2 inline-block size-2 rounded-full bg-primary"
                      role="img"
                      aria-label="Unread"
                    />
                  )}
                  {n.title}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(n.created_at).toLocaleString()} ·{" "}
                  {n.severity === "warning"
                    ? "Needs attention"
                    : n.severity === "success"
                      ? "Recovered or completed"
                      : "Information"}
                </p>
              </div>
              {mode === "inbox" && !n.read_at && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void markRead(n.id)}
                >
                  Mark read
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{n.body}</p>
            {mode === "history" && (
              <div className="space-y-1 text-xs">
                <p>
                  {n.in_app ? "In-app: available" : "In-app: not selected"} ·
                  Email: {deliveryLabels[n.email_status] ?? n.email_status}
                  {n.attempts
                    ? ` · ${n.attempts} attempt${n.attempts === 1 ? "" : "s"}`
                    : ""}
                </p>
                {n.error && (
                  <p className="text-muted-foreground">
                    {deliveryErrors[n.error] ?? "Delivery could not complete."}
                  </p>
                )}
                {n.email_status === "queued" && (
                  <p className="text-muted-foreground">
                    Next attempt: {new Date(n.next_attempt).toLocaleString()}
                  </p>
                )}
                {n.provider_id && (
                  <p className="break-all text-muted-foreground">
                    Resend message: {n.provider_id}
                  </p>
                )}
              </div>
            )}
            <Link to={n.href} className="text-sm underline underline-offset-4">
              Open{" "}
              {n.href.startsWith("/backups")
                ? "Backups"
                : n.href.startsWith("/machines")
                  ? "Machines"
                  : n.href.startsWith("/services")
                    ? "service"
                    : "notifications"}
            </Link>
          </article>
        ))}
      </div>
      {data.nextCursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void loadMore()}
        >
          Load older notifications
        </Button>
      )}
    </div>
  );
}
