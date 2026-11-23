import type { NotificationItem } from "@ephor/api/notifications";
import {
  ArrowClockwiseIcon,
  BellIcon,
  CheckIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { StatusIndicator } from "@/components/status-indicator";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Status = Pick<ComponentProps<typeof StatusIndicator>, "status" | "tone">;
const deliveryStatuses: Record<string, Status> = {
  queued: { status: "Queued for email", tone: "busy" },
  sending: { status: "Sending email", tone: "busy" },
  sent: { status: "Accepted by Resend", tone: "healthy" },
  failed: { status: "Email failed", tone: "error" },
  uncertain: { status: "Email delivery uncertain", tone: "error" },
  cancelled: { status: "Email cancelled", tone: "neutral" },
  skipped: { status: "Email not selected", tone: "neutral" },
};
const deliveryErrors: Record<string, string> = {
  EMAIL_DISABLED: "Email was disabled before this notification was sent.",
  SECURITY_DIGEST_REPLACED:
    "Replaced by grouped security summaries. Further per-finding email delivery was cancelled; an already-started delivery may have reached the provider.",
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
function severityStatus(severity: string): Status {
  return severity === "warning"
    ? { status: "Needs attention", tone: "error" }
    : severity === "success"
      ? { status: "Recovered or completed", tone: "healthy" }
      : { status: "Information", tone: "neutral" };
}

export function NotificationsTable({
  items,
  mode,
  loading,
  busy,
  onMarkRead,
}: {
  items: NotificationItem[];
  mode: "inbox" | "history";
  loading: boolean;
  busy: boolean;
  onMarkRead: (id: string) => void;
}) {
  return (
    <Table
      variant="layered"
      className="min-w-3xl table-fixed whitespace-nowrap [&_td]:px-3 [&_td]:py-2 [&_th]:px-3"
      aria-label={
        mode === "inbox"
          ? "Notification inbox"
          : "Notification delivery history"
      }
      aria-busy={loading || busy}
    >
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-[28%]">
            Notification
          </TableHead>
          <TableHead scope="col">Message</TableHead>
          <TableHead scope="col" className="w-48">
            {mode === "inbox" ? "Status" : "Email delivery"}
          </TableHead>
          <TableHead scope="col" className="w-36 text-right">
            Time
          </TableHead>
          <TableHead scope="col" className="w-22 text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {!items.length && (
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
                  Loading notifications…
                </div>
              ) : (
                <>
                  <BellIcon
                    aria-hidden="true"
                    className="mx-auto mb-3 size-7 text-muted-foreground"
                  />
                  <p className="font-medium">
                    {mode === "inbox"
                      ? "You’re all caught up"
                      : "No deliveries yet"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Choose what to receive in notification settings, or send a
                    test.
                  </p>
                </>
              )}
            </TableCell>
          </TableRow>
        )}
        {items.map((item) => {
          const createdAt = new Date(item.created_at);
          const timestamp = createdAt.toLocaleString(undefined, {
            dateStyle: "full",
            timeStyle: "long",
          });
          const severity = severityStatus(item.severity);
          const delivery: Status = deliveryStatuses[item.email_status] ?? {
            status: item.email_status,
            tone: "neutral",
          };
          const deliveryError = item.error
            ? (deliveryErrors[item.error] ?? "Delivery could not complete.")
            : undefined;
          return (
            <TableRow key={item.id} className={loading ? "opacity-50" : ""}>
              <TableHead scope="row" className="py-2 text-foreground">
                <Link
                  to={item.href}
                  title={item.title}
                  className="flex min-w-0 items-center gap-2 rounded-sm hover:underline focus-visible:outline-ring"
                >
                  <BellIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate text-sm font-medium">
                    {item.title}
                  </span>
                  {mode === "inbox" && !item.read_at && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                      role="img"
                      aria-label="Unread"
                    />
                  )}
                </Link>
              </TableHead>
              <TableCell>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={item.body}
                >
                  {item.body}
                </p>
              </TableCell>
              <TableCell>
                <div
                  className="truncate"
                  title={mode === "history" ? deliveryError : severity.status}
                >
                  <StatusIndicator
                    {...(mode === "inbox" ? severity : delivery)}
                  />
                </div>
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                <time
                  className="block truncate"
                  dateTime={createdAt.toISOString()}
                  title={timestamp}
                >
                  <span aria-hidden="true">
                    {createdAt.toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="sr-only">{timestamp}</span>
                </time>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  {mode === "inbox" && !item.read_at && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy || loading}
                      aria-label={`Mark ${item.title} as read`}
                      title="Mark read"
                      onClick={() => onMarkRead(item.id)}
                    >
                      <CheckIcon aria-hidden="true" />
                    </Button>
                  )}
                  <Popover>
                    <PopoverTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                      aria-label={`View details for ${item.title}`}
                      title="Notification details"
                    >
                      <InfoIcon aria-hidden="true" />
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      aria-label="Notification details"
                      className="max-h-(--available-height) w-96 gap-3 whitespace-normal"
                    >
                      <h2 className="font-medium break-words">{item.title}</h2>
                      <StatusIndicator {...severity} />
                      <p className="text-sm break-words text-muted-foreground">
                        {item.body}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {timestamp}
                      </p>
                      {mode === "history" && (
                        <>
                          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                            <dt className="text-muted-foreground">In-app</dt>
                            <dd>
                              {item.in_app ? "Available" : "Not selected"}
                            </dd>
                            <dt className="text-muted-foreground">Email</dt>
                            <dd>
                              <StatusIndicator {...delivery} />
                            </dd>
                            <dt className="text-muted-foreground">Attempts</dt>
                            <dd className="tabular-nums">{item.attempts}</dd>
                            {item.email_status === "queued" && (
                              <>
                                <dt className="text-muted-foreground">
                                  Next attempt
                                </dt>
                                <dd>
                                  {new Date(item.next_attempt).toLocaleString()}
                                </dd>
                              </>
                            )}
                            {item.provider_id && (
                              <>
                                <dt className="text-muted-foreground">
                                  Resend message
                                </dt>
                                <dd className="font-mono break-all">
                                  {item.provider_id}
                                </dd>
                              </>
                            )}
                          </dl>
                          {deliveryError && (
                            <p className="text-xs text-muted-foreground">
                              {deliveryError}
                            </p>
                          )}
                        </>
                      )}
                      <Link
                        to={item.href}
                        className="text-sm underline underline-offset-4"
                      >
                        Open{" "}
                        {item.href.startsWith("/backups")
                          ? "Backups"
                          : item.href.startsWith("/machines")
                            ? "Machines"
                            : item.href.startsWith("/services")
                              ? "service"
                              : "notifications"}
                      </Link>
                    </PopoverContent>
                  </Popover>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
