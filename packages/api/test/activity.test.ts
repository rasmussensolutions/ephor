import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApi } from "../src";
import { Activity } from "../src/activity/store";
import type { ActivityList } from "../src/activity/types";
import { OWNER_ID, randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import {
  Browser,
  enrolled,
  fixture,
  login,
  origin,
  timestamp,
} from "./helpers";

async function history(browser: Browser, query = ""): Promise<ActivityList> {
  const response = await browser.request(`/activity${query}`);
  expect(response.status).toBe(200);
  return response.json();
}
test("activity is authenticated and records real actors, failed actions, and resource snapshots", async () => {
  const f = await enrolled();
  expect((await new Browser(f.app).request("/activity")).status).toBe(401);
  const machines = new MachineStore(f.sql),
    machine = await machines.create("Original name");
  expect(
    (
      await f.browser.request("/machines/rename", {
        id: machine.id,
        name: "New name",
        user: { id: "spoofed", name: "Spoofed" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.browser.request("/machines/rename", { id: machine.id, name: "" }))
      .status,
  ).toBe(400);
  const entries = (await history(f.browser, "?category=machines")).items;
  expect(entries).toHaveLength(2);
  expect(entries.find((e) => e.outcome === "succeeded")?.target).toEqual({
    id: machine.id,
    name: "Original name",
    type: "machine",
  });
  expect(entries.find((e) => e.outcome === "failed")?.target.name).toBe(
    "New name",
  );
  expect(
    entries.every(
      (e) =>
        e.actor.id === OWNER_ID &&
        e.actor.name === "Owner" &&
        e.actor.kind === "user",
    ),
  ).toBe(true);
  expect((await history(f.browser, "?outcome=failed")).items).toHaveLength(1);
  expect((await history(f.browser, "?q=original")).items).toHaveLength(1);
  expect(
    (await history(f.browser, `?user=${OWNER_ID}&category=machines`)).items,
  ).toHaveLength(2);
});

test("authentication identifies the verified user and preserves the actor across sign-out", async () => {
  const f = await enrolled();
  const registration = (await history(f.browser)).items.find(
    (i) => i.action === "Register passkey",
  );
  expect(registration?.actor.id).toBe(OWNER_ID);
  expect((await f.browser.request("/auth/sign-out", {})).status).toBe(200);
  expect((await login(f.browser, f.key)).status).toBe(200);
  const entries = (await history(f.browser)).items;
  expect(entries.find((i) => i.action === "Sign in")?.actor.id).toBe(OWNER_ID);
  expect(entries.find((i) => i.action === "Sign out")?.actor.id).toBe(OWNER_ID);
});

test("all panel mutation categories are captured without storing secrets or response credentials", async () => {
  const f = await enrolled();
  const privateValue = "do-not-record-this-private-value";
  const endpoints = [
    "/services/create",
    "/backups/destinations",
    "/integrations/build-registry",
    "/notifications/settings",
    "/security/recovery-codes",
  ];
  for (const path of endpoints)
    await f.browser.request(path, {
      password: privateValue,
      apiKey: privateValue,
      environment: { SECRET: privateValue },
    });
  const rows = await f.sql.query("SELECT * FROM ephor_activity");
  expect(JSON.stringify(rows)).not.toContain(privateValue);
  expect(new Set(rows.map((r) => r.category))).toEqual(
    new Set([
      "security",
      "services",
      "backups",
      "integrations",
      "notifications",
    ]),
  );
  const recovery = await f.browser.request("/security/recovery-codes", {});
  const { codes } = await recovery.json();
  const persisted = JSON.stringify(
    await f.sql.query("SELECT * FROM ephor_activity"),
  );
  for (const code of codes) expect(persisted).not.toContain(code);
});

test("polling, activity reads, and daemon requests do not create panel activity", async () => {
  const f = await enrolled();
  const before = (await history(f.browser)).items.length;
  await f.browser.request("/session");
  await f.browser.request("/notifications");
  await f.app.request("/api/agent/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${randomToken()}`,
    },
    body: "{}",
  });
  expect((await history(f.browser)).items).toHaveLength(before);
});

test("pagination is stable for equal timestamps and supports literal search and date filters", async () => {
  const f = await fixture(),
    activity = new Activity(f.sql);
  for (let i = 0; i < 63; i++) {
    const id = await activity.start({
      action: i === 0 ? "Rename 100%_done" : "Rename machine",
      category: "machines",
      actor: {
        id: i % 2 ? "second-user" : "first-user",
        name: i % 2 ? "Second user" : "First user",
        kind: "user",
      },
      target: { id: null, name: null, type: null },
    });
    await f.sql.query(
      "UPDATE ephor_activity SET occurred_at=1000 WHERE id=$1",
      [id],
    );
  }
  const first = await activity.list(new URLSearchParams());
  expect(first.items).toHaveLength(50);
  const second = await activity.list(
    new URLSearchParams({ before: first.nextCursor ?? "" }),
  );
  expect(second.items).toHaveLength(13);
  expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(
    63,
  );
  expect(second.nextCursor).toBeNull();
  expect(
    (await activity.list(new URLSearchParams({ q: "%_" }))).items,
  ).toHaveLength(1);
  expect(
    (await activity.list(new URLSearchParams({ from: "1001" }))).items,
  ).toHaveLength(0);
  expect(
    (await activity.list(new URLSearchParams({ to: "1000" }))).items,
  ).toHaveLength(0);
  expect(
    (await activity.list(new URLSearchParams({ user: "second-user" }))).items,
  ).toHaveLength(31);
  expect(first.users).toHaveLength(2);
  const invalidQueries: Record<string, string>[] = [
    { before: "garbage" },
    { category: "bad" },
    { outcome: "bad" },
    { from: "NaN" },
    { q: "x".repeat(201) },
  ];
  for (const query of invalidQueries) {
    await expect(activity.list(new URLSearchParams(query))).rejects.toThrow(
      "INVALID_ACTIVITY",
    );
  }
});

test("invalid JSON and fresh-auth failures are logged with the authenticated actor", async () => {
  const f = await enrolled();
  const response = await f.browser.request("/machines/rename", null);
  expect(response.status).toBeGreaterThanOrEqual(400);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 15 * 60_000),
  ]);
  expect((await f.browser.request("/security/recovery-codes", {})).status).toBe(
    403,
  );
  const malformed = await f.app.request(`${origin}/api/notifications/read`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: [...f.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: "{",
  });
  expect(malformed.status).toBe(400);
  expect(
    (await history(f.browser, "?outcome=failed")).items.every(
      (i) => i.actor.id === OWNER_ID,
    ),
  ).toBe(true);
});

test("legacy migration preserves audit history and marks missing actor data honestly", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("../migrations/sqlite/0001_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    for (const event of [
      "machine.renamed",
      "service.configured",
      "backup.recovery_exported",
      "notification.test_requested",
      "github.disconnected",
    ]) {
      db.query("INSERT INTO ephor_auth_audit VALUES (?, ?, ?, ?)").run(
        event,
        event,
        "resource-id",
        1234,
      );
    }
    db.exec(
      readFileSync(
        new URL("../migrations/sqlite/0017_activity.sql", import.meta.url),
        "utf8",
      ),
    );
    const rows = db.query("SELECT * FROM ephor_activity").all() as {
      category: string;
      actor_id: string | null;
      actor_kind: string;
      outcome: string;
      occurred_at: number;
    }[];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.category))).toEqual(
      new Set([
        "machines",
        "services",
        "backups",
        "notifications",
        "integrations",
      ]),
    );
    expect(
      rows.every(
        (row) =>
          row.actor_id === null &&
          row.actor_kind === "unknown" &&
          row.outcome === "unknown" &&
          row.occurred_at === 1234,
      ),
    ).toBe(true);
    expect(db.query("SELECT * FROM ephor_auth_audit").all()).toHaveLength(5);
  } finally {
    db.close();
  }
});

test("activity insert failure stops execution; finalization failure retains an unconfirmed record", async () => {
  const f = await enrolled();
  const machines = new MachineStore(f.sql),
    machine = await machines.create("Before");
  for (const stage of ["INSERT", "UPDATE"]) {
    const sql = {
      async query<T extends Record<string, unknown>>(
        query: string,
        values?: unknown[],
      ): Promise<T[]> {
        if (
          query.startsWith(
            `${stage} ${stage === "INSERT" ? "INTO " : ""}ephor_activity`,
          )
        )
          throw new Error("Simulated activity storage outage");
        return f.sql.query<T>(query, values);
      },
    };
    const browser = new Browser(createApi({ ...f.env, sql }));
    browser.cookies = new Map(f.browser.cookies);
    expect(
      (
        await browser.request("/machines/rename", {
          id: machine.id,
          name: "After",
        })
      ).status,
    ).toBe(500);
    expect((await machines.get(machine.id)).name).toBe(
      stage === "INSERT" ? "Before" : "After",
    );
  }
  const entries = (await history(f.browser, "?category=machines")).items;
  expect(entries).toHaveLength(1);
  expect(entries[0]?.outcome).toBe("pending");
  expect(entries[0]?.actor.id).toBe(OWNER_ID);
});
