import { expect, test } from "bun:test";
import type { NotificationItem } from "@ephor/api/notifications";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationsTable } from "../src/components/notifications/notifications-table";

const notification: NotificationItem = {
  id: "notification",
  event_type: "backup_failed",
  title: "Backup failed",
  body: "The scheduled backup for the customer database could not complete.",
  href: "/backups",
  severity: "warning",
  in_app: 1,
  read_at: null,
  created_at: 1795086000000,
  email_status: "failed",
  attempts: 3,
  next_attempt: 1795086060000,
  last_attempt: 1795086000000,
  provider_id: null,
  error: "RESEND_ACCESS_DENIED",
};

function renderTable(
  props: Partial<ComponentProps<typeof NotificationsTable>> = {},
) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <NotificationsTable
        items={[notification]}
        mode="inbox"
        loading={false}
        busy={false}
        onMarkRead={() => {}}
        {...props}
      />
    </RouterContextProvider>,
  );
}

test("notifications use the same layered, fixed-layout table as activity", () => {
  const html = renderTable();
  expect(html).toContain('data-variant="layered"');
  expect(html).toContain("table-fixed whitespace-nowrap");
  expect(html).toContain('aria-label="Notification inbox"');
  expect(html.match(/scope="col"/g)).toHaveLength(5);
  expect(html).toContain('scope="row"');
  expect(html).not.toContain("<article");
});

test("long notification titles and messages truncate without losing their full text", () => {
  const title = "Backup failed for a customer database ".repeat(8);
  const body = "A long notification message with additional context. ".repeat(
    12,
  );
  const html = renderTable({ items: [{ ...notification, title, body }] });
  expect(html).toContain(`title="${title}"`);
  expect(html).toContain(`title="${body}"`);
  expect(html).toContain(
    `class="truncate text-sm font-medium">${title}</span>`,
  );
  expect(html).toContain(
    `class="truncate text-xs text-muted-foreground" title="${body}"`,
  );
  expect(html).toContain('href="/backups"');
  expect(html).toContain(`aria-label="View details for ${title}"`);
});

test("unread notifications retain their indicator and mark-read action", () => {
  const html = renderTable();
  expect(html).toContain('aria-label="Unread"');
  expect(html).toContain('aria-label="Mark Backup failed as read"');
  expect(html).toContain("Needs attention");
});

test("read notifications keep their details without an unread indicator or read action", () => {
  const html = renderTable({
    items: [{ ...notification, read_at: 1795086100000 }],
  });
  expect(html).not.toContain('aria-label="Unread"');
  expect(html).not.toContain('aria-label="Mark Backup failed as read"');
  expect(html).toContain('aria-label="View details for Backup failed"');
});

test("delivery history shows delivery status and error context rather than read actions", () => {
  const html = renderTable({ mode: "history" });
  expect(html).toContain('aria-label="Notification delivery history"');
  expect(html).toContain("Email delivery");
  expect(html).toContain("Email failed");
  expect(html).toContain(
    "Resend rejected access. Check the API key, sending domain, and its permissions.",
  );
  expect(html).toContain('aria-label="View details for Backup failed"');
  expect(html).not.toContain('aria-label="Unread"');
  expect(html).not.toContain('aria-label="Mark Backup failed as read"');
});

for (const [email_status, label] of [
  ["queued", "Queued for email"],
  ["sending", "Sending email"],
  ["sent", "Accepted by Resend"],
  ["uncertain", "Email delivery uncertain"],
  ["cancelled", "Email cancelled"],
  ["skipped", "Email not selected"],
  ["unknown_status", "unknown_status"],
] as const) {
  test(`delivery history preserves the ${email_status} status`, () => {
    expect(
      renderTable({
        mode: "history",
        items: [{ ...notification, email_status }],
      }),
    ).toContain(label);
  });
}

test("timestamps stay compact with the full date available", () => {
  const html = renderTable();
  expect(html).toContain('class="block truncate"');
  expect(html).toContain(
    `dateTime="${new Date(notification.created_at).toISOString()}"`,
  );
  expect(html).toContain(
    new Date(notification.created_at).toLocaleString(undefined, {
      dateStyle: "full",
      timeStyle: "long",
    }),
  );
});

test("read actions are disabled while notifications are being updated", () => {
  for (const state of [{ busy: true }, { loading: true }]) {
    const html = renderTable(state);
    expect(html).toContain('aria-busy="true"');
    const button = html.match(
      /<button\b[^>]*aria-label="Mark Backup failed as read"[^>]*>/,
    )?.[0];
    expect(button).toBeDefined();
    expect(button).toMatch(/\sdisabled(?:=|[\s>])/);
  }
});

test("empty inbox and history retain their own empty states", () => {
  expect(renderTable({ items: [] })).toContain("You’re all caught up");
  expect(renderTable({ mode: "history", items: [] })).toContain(
    "No deliveries yet",
  );
});

test("switching views displays a loading state rather than an empty inbox", () => {
  const html = renderTable({ items: [], loading: true });
  expect(html).toContain("Loading notifications…");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("You’re all caught up");
});
