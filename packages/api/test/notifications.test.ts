import { expect, test } from "bun:test";
import { Notifications } from "../src/notifications/store";
import { defaultPreferences } from "../src/notifications/types";
import { enrolled, fixture, timestamp } from "./helpers";

const DAY = 86400000;
const config = {
  enabled: true,
  apiKey: "re_test_secret_123456789",
  from: "alerts@example.com",
  recipients: ["owner@example.com"],
  preferences: defaultPreferences(),
};
async function setup() {
  const f = await fixture();
  let now = Date.now();
  const requests: { url: string; init: RequestInit }[] = [];
  let handler: () => Response | Promise<Response> = () =>
    Response.json({ id: "provider-message-1" });
  const send = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return handler();
  }) as unknown as typeof fetch;
  const n = new Notifications(
    f.sql,
    f.env.secret,
    f.env.origin,
    send,
    () => now,
  );
  await n.settings();
  return {
    ...f,
    n,
    requests,
    setNow: (v: number) => {
      now = v;
    },
    now: () => now,
    advance: (v: number) => {
      now += v;
    },
    respond: (fn: typeof handler) => {
      handler = fn;
    },
  };
}
async function sources(f: Awaited<ReturnType<typeof setup>>) {
  const m = crypto.randomUUID(),
    s = crypto.randomUUID(),
    d = crypto.randomUUID(),
    p = crypto.randomUUID();
  await f.sql.query(
    "INSERT INTO ephor_machine (id,name,state,enrollment_hash,enrollment_expires,created_at,enrolled_at,last_seen) VALUES ($1,'Test machine','active',$1,0,$2,$2,$2)",
    [m, f.now()],
  );
  await f.sql.query(
    "INSERT INTO ephor_service (id,machine_id,name,config,source,created_at) VALUES ($1,$2,'Database','{}','{}',$3)",
    [s, m, f.now()],
  );
  await f.sql.query(
    "INSERT INTO ephor_backup_destination (id,name,config,status,checked_machine,check_password,created_at) VALUES ($1,'R2','encrypted','ready',$2,'encrypted',$3)",
    [d, m, f.now()],
  );
  await f.sql.query(
    "INSERT INTO ephor_backup_plan (id,service_id,destination_id,password,frequency,hour,next_run,created_at) VALUES ($1,$2,$3,'encrypted','daily',2,$4,$4)",
    [p, s, d, f.now()],
  );
  async function job(status: string, action = "backup") {
    const id = crypto.randomUUID();
    f.advance(1);
    await f.sql.query(
      "INSERT INTO ephor_backup_job (id,machine_id,service_id,plan_id,destination_id,action,payload,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'encrypted',$7,$8,$8)",
      [id, m, s, p, d, action, status, f.now()],
    );
    return id;
  }
  return { m, s, d, p, job };
}
test("notification settings and queued credentials are encrypted; responses never expose keys", async () => {
  const f = await setup();
  expect((await f.n.settings()).preferences.backup_succeeded.inApp).toBe(false);
  await f.n.save(config);
  await f.n.test({ channel: "email" });
  const raw =
    JSON.stringify(
      await f.sql.query("SELECT * FROM ephor_notification_settings"),
    ) + JSON.stringify(await f.sql.query("SELECT * FROM ephor_notification"));
  expect(raw).not.toContain(config.apiKey);
  expect(raw).not.toContain(config.recipients[0]);
  expect(JSON.stringify(await f.n.settings())).not.toContain(config.apiKey);
  expect(JSON.stringify(await f.n.list("history"))).not.toContain(
    "email_config",
  );
  await expect(
    f.n.save({ ...config, from: "alerts@example.com\r\nBcc:evil@example.com" }),
  ).rejects.toThrow("INVALID_NOTIFICATION_EMAIL");
  await expect(
    f.n.save({ ...config, apiKey: "re_bad\nheader" }),
  ).rejects.toThrow("INVALID_RESEND_KEY");
});
test("email tests use fixed Resend endpoint, frozen recipients and idempotent delivery; in-app preferences stay independent", async () => {
  const f = await setup();
  await f.n.save(config);
  const job = await f.n.test({ channel: "email" });
  await f.n.save({ ...config, apiKey: "", recipients: ["new@example.com"] });
  await f.n.test({ channel: "inApp" });
  await f.n.deliver();
  await f.n.deliver();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.url).toBe("https://api.resend.com/emails");
  const init = f.requests[0]?.init;
  expect(init?.redirect).toBe("error");
  expect(new Headers(init?.headers).get("idempotency-key")).toBe(
    `ephor-notification/${job.id}`,
  );
  expect(JSON.parse(String(init?.body)).to).toEqual(config.recipients);
  const inbox = await f.n.list("inbox");
  expect(inbox.unread).toBe(1);
  await f.n.read({ id: inbox.items[0]?.id });
  expect((await f.n.list("inbox")).unread).toBe(0);
  const row = (await f.n.list("history")).items.find((i) => i.id === job.id);
  expect(row?.email_status).toBe("sent");
  expect(
    (
      await f.sql.query(
        "SELECT email_config FROM ephor_notification WHERE id=$1",
        [job.id],
      )
    )[0]?.email_config,
  ).toBeNull();
});
test("temporary failures retry with the same payload; disabling email cancels queued messages", async () => {
  const f = await setup();
  await f.n.save(config);
  await f.n.test({ channel: "email" });
  f.respond(
    () =>
      new Response("provider secret must not be stored", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  );
  await f.n.deliver();
  await f.n.deliver();
  expect(f.requests).toHaveLength(1);
  let row = (await f.n.list("history")).items[0];
  expect(row?.email_status).toBe("queued");
  expect(row?.error).toBe("RESEND_RATE_LIMITED");
  f.advance(120001);
  f.respond(() => Response.json({ id: "retry-message" }));
  await f.n.deliver();
  expect(f.requests[0]?.init.body).toBe(f.requests[1]?.init.body);
  expect(new Headers(f.requests[0]?.init.headers).get("idempotency-key")).toBe(
    new Headers(f.requests[1]?.init.headers).get("idempotency-key"),
  );
  await f.n.test({ channel: "email" });
  await f.n.save({ ...config, enabled: false });
  await f.n.deliver();
  row = (await f.n.list("history")).items.find(
    (i) => i.email_status === "cancelled",
  );
  expect(row).toBeDefined();
  expect(f.requests).toHaveLength(2);
});
test("a lost acknowledgement retries within Resend's window and stops after it expires", async () => {
  const f = await setup();
  await f.n.save(config);
  const job = await f.n.test({ channel: "email" });
  let lose = true;
  const sql = {
    query: async <T extends Record<string, unknown>>(
      q: string,
      v: unknown[] = [],
    ) => {
      if (
        lose &&
        q.startsWith("UPDATE ephor_notification SET email_status=$1")
      ) {
        lose = false;
        throw new Error("Database temporarily unavailable");
      }
      return f.sql.query<T>(q, v);
    },
  };
  const n = new Notifications(
    sql,
    f.env.secret,
    f.env.origin,
    (async () =>
      Response.json({
        id: "accepted-before-crash",
      })) as unknown as typeof fetch,
    f.now,
  );
  await expect(n.deliver()).rejects.toThrow();
  const row = (await f.n.list("history")).items.find((i) => i.id === job.id);
  expect(row?.email_status).toBe("sending");
  f.advance(61000);
  await f.n.deliver();
  expect(f.requests).toHaveLength(1);
  expect(new Headers(f.requests[0]?.init.headers).get("idempotency-key")).toBe(
    `ephor-notification/${job.id}`,
  );
  const late = await f.n.test({ channel: "email" });
  await f.sql.query(
    "UPDATE ephor_notification SET email_status='sending',first_attempt=$1,lease_until=0 WHERE id=$2",
    [f.now(), late.id],
  );
  f.advance(DAY);
  await f.n.deliver();
  expect(
    (await f.n.list("history")).items.find((i) => i.id === late.id)
      ?.email_status,
  ).toBe("uncertain");
  expect(f.requests).toHaveLength(1);
});
test("concurrent dispatchers cannot claim the same email", async () => {
  const f = await setup();
  await f.n.save(config);
  await f.n.test({ channel: "email" });
  await Promise.all([f.n.deliver(), f.n.deliver(), f.n.deliver()]);
  expect(f.requests).toHaveLength(1);
});
test("backup failures open one incident, successful backups resolve it, and preferences suppress routine success", async () => {
  const f = await setup();
  const s = await sources(f);
  await s.job("failed");
  await f.n.tick();
  await f.n.tick();
  await s.job("failed");
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "backup_failed",
    ),
  ).toHaveLength(1);
  await s.job("succeeded");
  await f.n.tick();
  const inbox = await f.n.list("inbox");
  expect(
    inbox.items.filter((i) => i.event_type === "backup_recovered"),
  ).toHaveLength(1);
  expect(
    inbox.items.filter((i) => i.event_type === "backup_succeeded"),
  ).toHaveLength(0);
  await s.job("failed");
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "backup_failed",
    ),
  ).toHaveLength(2);
});
test("background evaluation detects offline, recovery and overdue backups without browser requests", async () => {
  const f = await setup();
  const s = await sources(f);
  f.advance(300001);
  await f.n.tick();
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "machine_offline",
    ),
  ).toHaveLength(1);
  await f.sql.query("UPDATE ephor_machine SET last_seen=$1 WHERE id=$2", [
    f.now(),
    s.m,
  ]);
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "machine_recovered",
    ),
  ).toHaveLength(1);
  f.advance(DAY + 3600001);
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "backup_overdue",
    ),
  ).toHaveLength(1);
  await s.job("succeeded");
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.some((i) =>
      i.title.startsWith("Backup freshness restored"),
    ),
  ).toBe(true);
  const before = (await f.n.list("inbox")).items.filter(
    (i) => i.event_type === "machine_offline",
  ).length;
  f.advance(DAY);
  await f.n.tick();
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "machine_offline",
    ),
  ).toHaveLength(before + 1);
});
test("storage, restore and deployment results are captured once with no raw worker output", async () => {
  const f = await setup();
  const s = await sources(f);
  await s.job("failed", "check");
  await s.job("succeeded", "restore");
  await f.sql.query(
    "INSERT INTO ephor_deployment (id,service_id,machine_id,action,spec,status,created_at,updated_at,error) VALUES ($1,$2,$3,'deploy','{}','failed',$4,$4,'SECRET_FROM_WORKER')",
    [crypto.randomUUID(), s.s, s.m, f.now()],
  );
  await f.n.tick();
  await f.n.tick();
  const data = await f.n.list("inbox");
  expect(data.items).toHaveLength(3);
  expect(JSON.stringify(data)).not.toContain("SECRET_FROM_WORKER");
});
test("delivery history paginates equal timestamps without losing notifications", async () => {
  const f = await setup();
  for (let i = 0; i < 105; i++)
    await f.n.emit({
      key: `test-page:${i}`,
      type: "machine_offline",
      title: "Example",
      body: "Example",
      href: "/machines",
      severity: "warning",
    });
  const first = await f.n.list("inbox");
  expect(first.items).toHaveLength(100);
  expect(first.nextCursor).toBeTruthy();
  const second = await f.n.list("inbox", first.nextCursor ?? undefined);
  expect(second.items).toHaveLength(5);
  expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(
    105,
  );
});
test("owner-only settings and tests require exact origin and fresh passkey; read state does not", async () => {
  const f = await enrolled();
  expect((await f.app.request("/api/notifications")).status).toBe(401);
  expect(
    (await f.browser.request("/notifications/settings", config)).status,
  ).toBe(200);
  expect(
    JSON.stringify(
      await (await f.browser.request("/notifications/settings")).json(),
    ),
  ).not.toContain(config.apiKey);
  expect(
    (
      await f.browser.request(
        "/notifications/test",
        { channel: "inApp" },
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect(
    (await f.browser.request("/notifications/settings", config)).status,
  ).toBe(403);
  expect(
    (await f.browser.request("/notifications/test", { channel: "email" }))
      .status,
  ).toBe(403);
  expect(
    (await f.browser.request("/notifications/read", { id: "all" })).status,
  ).toBe(200);
});

test("one successful backup resolves failure and overdue without duplicate recovery messages", async () => {
  const f = await setup();
  const s = await sources(f);
  await s.job("failed");
  await f.n.tick();
  f.advance(DAY + 3600001);
  await f.n.tick();
  await s.job("succeeded");
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "backup_recovered",
    ),
  ).toHaveLength(1);
});
test("relaxing a backup schedule does not claim a successful recovery", async () => {
  const f = await setup();
  const s = await sources(f);
  await s.job("succeeded");
  await f.n.tick();
  f.advance(DAY + 3600001);
  await f.n.tick();
  await f.sql.query(
    "UPDATE ephor_backup_plan SET frequency='weekly' WHERE id=$1",
    [s.p],
  );
  await f.n.tick();
  expect(
    (await f.n.list("inbox")).items.filter(
      (i) => i.event_type === "backup_recovered",
    ),
  ).toHaveLength(0);
});
test("permanent email rejection is visible and does not retry or retain credentials", async () => {
  const f = await setup();
  await f.n.save(config);
  const test = await f.n.test({ channel: "email" });
  f.respond(
    () =>
      new Response("raw provider error including a secret", { status: 403 }),
  );
  await f.n.deliver();
  f.advance(DAY);
  await f.n.deliver();
  const row = (await f.n.list("history")).items.find((i) => i.id === test.id);
  expect(row?.email_status).toBe("failed");
  expect(row?.error).toBe("RESEND_ACCESS_DENIED");
  expect(f.requests).toHaveLength(1);
  expect(
    (
      await f.sql.query(
        "SELECT email_config FROM ephor_notification WHERE id=$1",
        [test.id],
      )
    )[0]?.email_config,
  ).toBeNull();
});
