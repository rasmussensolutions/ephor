import type { AuthEnvironment } from "../auth/config";
import { AuthError, AuthStore, type Sql } from "../auth/store";
import { maintainSecurity } from "../security/maintenance";
import { ServiceSecrets } from "../services/crypto";
import { object } from "../services/spec";
import { retireSecurityAlerts } from "./security-legacy";
import {
  defaultPreferences,
  type EventType,
  type NotificationItem,
  notificationEvents,
  type Preferences,
} from "./types";

const DAY = 86400000;
const RETRY_WINDOW = 23 * 3600000; // Stop before Resend's 24-hour idempotency window expires.
interface EmailConfig {
  enabled: boolean;
  apiKey: string;
  from: string;
  recipients: string[];
}
interface SettingsRow extends Record<string, unknown> {
  config: string;
  preferences: string;
  started_at: number;
  updated_at: number;
}
interface Delivery extends Record<string, unknown> {
  id: string;
  email_config: string;
  title: string;
  body: string;
  href: string;
  attempts: number;
  first_attempt: number;
  lease_owner: string;
}
interface Event {
  key: string;
  type: EventType | "test";
  title: string;
  body: string;
  href: string;
  severity: "info" | "warning" | "success";
}
const blank: EmailConfig = {
  enabled: false,
  apiKey: "",
  from: "",
  recipients: [],
};
function email(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(
      value,
    )
  )
    throw new AuthError("INVALID_NOTIFICATION_EMAIL");
  return value;
}
function label(value: unknown) {
  return String(value ?? "Service")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 80);
}
export class Notifications {
  readonly secrets: ServiceSecrets;
  constructor(
    readonly sql: Sql,
    secret: string,
    readonly origin: string,
    readonly send: typeof fetch = fetch,
    readonly clock: () => number = Date.now,
  ) {
    this.secrets = new ServiceSecrets(`notifications:${secret}`);
  }
  async settingsRow() {
    const [existing] = await this.sql.query<SettingsRow>(
      "SELECT * FROM ephor_notification_settings WHERE id=1",
    );
    if (existing) return existing;
    await this.sql.query(
      "INSERT INTO ephor_notification_settings (id,config,preferences,started_at,updated_at) VALUES (1,$1,$2,$3,$3) ON CONFLICT(id) DO NOTHING",
      [
        await this.secrets.seal("settings", blank),
        JSON.stringify(defaultPreferences()),
        this.clock(),
      ],
    );
    const [row] = await this.sql.query<SettingsRow>(
      "SELECT * FROM ephor_notification_settings WHERE id=1",
    );
    if (!row) throw new Error("Notification settings unavailable");
    return row;
  }
  async settings() {
    const row = await this.settingsRow();
    const c = await this.secrets.open<EmailConfig>("settings", row.config);
    return {
      enabled: c.enabled,
      from: c.from,
      recipients: c.recipients,
      hasKey: !!c.apiKey,
      preferences: {
        ...defaultPreferences(),
        ...JSON.parse(row.preferences),
      } as Preferences,
    };
  }
  async save(value: unknown) {
    const b = object(value),
      row = await this.settingsRow();
    const old = await this.secrets.open<EmailConfig>("settings", row.config);
    if (typeof b.enabled !== "boolean")
      throw new AuthError("INVALID_NOTIFICATION_SETTINGS");
    const preferences = object(b.preferences),
      parsed = defaultPreferences();
    for (const e of notificationEvents) {
      const p = object(preferences[e.id]);
      if (typeof p.inApp !== "boolean" || typeof p.email !== "boolean")
        throw new AuthError("INVALID_NOTIFICATION_SETTINGS");
      parsed[e.id] = { inApp: p.inApp, email: p.email };
    }
    const apiKey =
      b.removeKey === true
        ? ""
        : b.apiKey === "" || b.apiKey === undefined
          ? old.apiKey
          : b.apiKey;
    if (
      typeof apiKey !== "string" ||
      (apiKey && !/^re_[A-Za-z0-9_-]{8,200}$/.test(apiKey))
    )
      throw new AuthError("INVALID_RESEND_KEY");
    if (!Array.isArray(b.recipients) || b.recipients.length > 5)
      throw new AuthError("INVALID_NOTIFICATION_EMAIL");
    const config: EmailConfig = {
      enabled: b.enabled,
      apiKey,
      from: b.from === "" ? "" : email(b.from),
      recipients: [...new Set(b.recipients.map(email))],
    };
    if (
      config.enabled &&
      (!config.apiKey || !config.from || !config.recipients.length)
    )
      throw new AuthError("NOTIFICATION_EMAIL_NOT_CONFIGURED");
    await this.sql.query(
      "UPDATE ephor_notification_settings SET config=$1,preferences=$2,updated_at=$3 WHERE id=1",
      [
        await this.secrets.seal("settings", config),
        JSON.stringify(parsed),
        this.clock(),
      ],
    );
    if (!config.enabled)
      await this.sql.query(
        "UPDATE ephor_notification SET email_status='cancelled',email_config=NULL,error='EMAIL_DISABLED' WHERE email_status='queued'",
      );
    await new AuthStore(this.sql).audit("notification.settings_changed");
    return this.settings();
  }
  async emit(event: Event, testChannel?: "email" | "inApp") {
    const row = await this.settingsRow();
    const config = await this.secrets.open<EmailConfig>("settings", row.config);
    const prefs =
      event.type === "test"
        ? { inApp: testChannel === "inApp", email: testChannel === "email" }
        : (
            {
              ...defaultPreferences(),
              ...JSON.parse(row.preferences),
            } as Preferences
          )[event.type];
    const wantsEmail = prefs.email && config.enabled;
    if (testChannel === "email" && !wantsEmail)
      throw new AuthError("NOTIFICATION_EMAIL_NOT_CONFIGURED", 409);
    const id = crypto.randomUUID();
    // One durable row holds the inbox item and immutable email envelope. Retrying cannot create a second delivery.
    await this.sql.query(
      "INSERT INTO ephor_notification (id,event_key,event_type,title,body,href,severity,in_app,created_at,email_status,email_config,next_attempt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9) ON CONFLICT(event_key) DO NOTHING",
      [
        id,
        event.key,
        event.type,
        event.title,
        event.body,
        event.href,
        event.severity,
        prefs.inApp ? 1 : 0,
        this.clock(),
        wantsEmail ? "queued" : "skipped",
        wantsEmail
          ? await this.secrets.seal(id, { ...config, origin: this.origin })
          : null,
      ],
    );
    const [saved] = await this.sql.query<{ id: string }>(
      "SELECT id FROM ephor_notification WHERE event_key=$1",
      [event.key],
    );
    return { id: saved?.id };
  }
  async test(value: unknown) {
    const channel = object(value).channel;
    if (channel !== "email" && channel !== "inApp")
      throw new AuthError("INVALID_NOTIFICATION_SETTINGS");
    await new AuthStore(this.sql).limit("notification:test", 5);
    const result = await this.emit(
      {
        key: `test:${crypto.randomUUID()}`,
        type: "test",
        title: "Test notification",
        body: "Notifications are connected. Ephor will use your saved preferences for future alerts.",
        href: "/notifications",
        severity: "info",
      },
      channel,
    );
    await new AuthStore(this.sql).audit(
      "notification.test_requested",
      result.id,
    );
    return result;
  }
  async list(mode: string, before?: string) {
    if (!["inbox", "history"].includes(mode))
      throw new AuthError("INVALID_NOTIFICATION_SETTINGS");
    const [time, cursorId = ""] = before?.split(":") ?? [];
    const cutoff = before === undefined ? this.clock() + 1 : Number(time);
    if (
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      (before !== undefined && !/^[a-f0-9-]{36}$/.test(cursorId))
    )
      throw new AuthError("INVALID_NOTIFICATION_SETTINGS");
    const rows = await this.sql.query<
      NotificationItem & Record<string, unknown>
    >(
      `SELECT id,event_type,title,body,href,severity,in_app,read_at,created_at,email_status,attempts,next_attempt,last_attempt,provider_id,error FROM ephor_notification WHERE (created_at<$1 OR (created_at=$1 AND id<$2)) ${mode === "inbox" ? "AND in_app=1" : "AND (in_app=1 OR email_status<>'skipped')"} ORDER BY created_at DESC,id DESC LIMIT 101`,
      [cutoff, cursorId],
    );
    const [count] = await this.sql.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM ephor_notification WHERE in_app=1 AND read_at IS NULL",
    );
    const [runtime] = await this.sql.query<{ last_run: number }>(
      "SELECT last_run FROM ephor_notification_runtime WHERE id=1",
    );
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return {
      nextCursor:
        rows.length > 100 && last ? `${last.created_at}:${last.id}` : null,
      items: page.map((r) => ({
        ...r,
        in_app: Number(r.in_app),
        read_at: r.read_at === null ? null : Number(r.read_at),
        created_at: Number(r.created_at),
        attempts: Number(r.attempts),
        next_attempt: Number(r.next_attempt),
        last_attempt: r.last_attempt === null ? null : Number(r.last_attempt),
      })),
      unread: Number(count?.total ?? 0),
      lastRun: Number(runtime?.last_run ?? 0),
    };
  }
  async read(value: unknown) {
    const id = object(value).id;
    if (id !== "all" && (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)))
      throw new AuthError("INVALID_NOTIFICATION_SETTINGS");
    if (id === "all")
      await this.sql.query(
        "UPDATE ephor_notification SET read_at=$1 WHERE in_app=1 AND read_at IS NULL",
        [this.clock()],
      );
    else
      await this.sql.query(
        "UPDATE ephor_notification SET read_at=$1 WHERE id=$2 AND in_app=1 AND read_at IS NULL",
        [this.clock(), id],
      );
    return { ok: true };
  }
  async condition(
    id: string,
    active: boolean,
    event: Event,
    recovery?: Event,
    recoveryAt?: number,
  ) {
    const [old] = await this.sql.query<{
      active: number;
      episode: string;
      notified_at: number;
    }>("SELECT * FROM ephor_notification_condition WHERE id=$1", [id]);
    if (active) {
      if (!old || !Number(old.active)) {
        await this.emit(event);
        await this.sql.query(
          "INSERT INTO ephor_notification_condition (id,active,episode,notified_at) VALUES ($1,1,$2,$3) ON CONFLICT(id) DO UPDATE SET active=1,episode=$2,notified_at=$3",
          [id, event.key, this.clock()],
        );
      } else if (this.clock() - Number(old.notified_at) >= DAY) {
        await this.emit({
          ...event,
          key: `reminder:${old.episode}:${Math.floor(this.clock() / DAY)}`,
          title: `Still unresolved: ${event.title}`,
        });
        await this.sql.query(
          "UPDATE ephor_notification_condition SET notified_at=$1 WHERE id=$2",
          [this.clock(), id],
        );
      }
    } else if (old && Number(old.active)) {
      if (
        recovery &&
        (recoveryAt === undefined || recoveryAt > Number(old.notified_at))
      )
        await this.emit(recovery);
      await this.sql.query(
        "UPDATE ephor_notification_condition SET active=0 WHERE id=$1",
        [id],
      );
    }
  }
  async collect(keepLease: () => Promise<boolean> = async () => true) {
    const settings = await this.settingsRow();
    const cutoff = Math.max(
      Number(settings.started_at),
      this.clock() - 90 * DAY,
    );
    const jobs = await this.sql.query<{
      id: string;
      action: string;
      status: string;
      plan_id: string | null;
      service_id: string | null;
      name: string;
      destination_name: string;
    }>(
      "SELECT j.id,j.action,j.status,j.plan_id,j.service_id,s.name,d.name AS destination_name FROM ephor_backup_job j LEFT JOIN ephor_service s ON s.id=j.service_id JOIN ephor_backup_destination d ON d.id=j.destination_id WHERE j.status IN ('succeeded','failed') AND j.updated_at >= $1 AND NOT EXISTS (SELECT 1 FROM ephor_notification_source n WHERE n.id='backup:' || j.id) ORDER BY j.updated_at,j.id LIMIT 100",
      [cutoff],
    );
    for (const j of jobs) {
      if (!(await keepLease())) return;
      const name = label(j.name),
        base = { href: "/backups", severity: "warning" as const };
      if (j.action === "backup" && j.plan_id) {
        await this.condition(
          `backup:${j.plan_id}`,
          j.status === "failed",
          {
            ...base,
            key: `backup-failed:${j.id}`,
            type: "backup_failed",
            title: `Backup failed: ${name}`,
            body: "The backup did not complete verification. Open Backups to inspect the failure and retry.",
          },
          {
            ...base,
            severity: "success",
            key: `backup-recovered:${j.id}`,
            type: "backup_recovered",
            title: `Backups recovered: ${name}`,
            body: "A new backup completed verification after an earlier failure.",
          },
        );
        if (j.status === "succeeded")
          await this.emit({
            ...base,
            severity: "success",
            key: `backup-succeeded:${j.id}`,
            type: "backup_succeeded",
            title: `Backup verified: ${name}`,
            body: "An encrypted off-site backup completed verification.",
          });
      } else if (j.action === "restore") {
        await this.emit({
          ...base,
          key: `restore:${j.id}`,
          type: "restore_finished",
          severity: j.status === "succeeded" ? "success" : "warning",
          title: `Restore ${j.status === "succeeded" ? "completed" : "failed"}: ${name}`,
          body:
            j.status === "succeeded"
              ? "The restored service is ready for you to inspect before switching traffic."
              : "The restore did not complete. Inspect its history before retrying.",
        });
      } else if (j.action === "check" && j.status === "failed")
        await this.emit({
          ...base,
          key: `storage:${j.id}`,
          type: "storage_failed",
          title: `Storage check failed: ${label(j.destination_name)}`,
          body: "Check the bucket endpoint and jurisdiction, credentials, and worker connectivity in Backups.",
        });
      await this.sql.query(
        "INSERT INTO ephor_notification_source (id,processed_at) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING",
        [`backup:${j.id}`, this.clock()],
      );
    }
    const deployments = await this.sql.query<{
      id: string;
      name: string;
      service_id: string;
    }>(
      "SELECT d.id,d.service_id,s.name FROM ephor_deployment d JOIN ephor_service s ON s.id=d.service_id WHERE d.status='failed' AND d.updated_at >= $1 AND NOT EXISTS (SELECT 1 FROM ephor_notification_source n WHERE n.id='deployment:' || d.id) ORDER BY d.updated_at,d.id LIMIT 100",
      [cutoff],
    );
    for (const d of deployments) {
      if (!(await keepLease())) return;
      await this.emit({
        key: `deployment:${d.id}`,
        type: "deployment_failed",
        title: `Deployment failed: ${label(d.name)}`,
        body: "A deployment operation failed. Open the service to inspect its status.",
        href: `/services/${d.service_id}`,
        severity: "warning",
      });
      await this.sql.query(
        "INSERT INTO ephor_notification_source (id,processed_at) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING",
        [`deployment:${d.id}`, this.clock()],
      );
    }
    const machines = await this.sql.query<{
      id: string;
      name: string;
      last_seen: number;
      enrolled_at: number;
    }>(
      "SELECT id,name,last_seen,enrolled_at FROM ephor_machine WHERE state='active'",
    );
    for (const m of machines) {
      if (!(await keepLease())) return;
      const seen = Number(m.last_seen ?? m.enrolled_at),
        name = label(m.name);
      await this.condition(
        `machine:${m.id}`,
        this.clock() - seen > 300000,
        {
          key: `offline:${m.id}:${seen}`,
          type: "machine_offline",
          title: `Machine offline: ${name}`,
          body: "Ephor has not received telemetry for more than five minutes. Check the machine and its network connection.",
          href: "/machines",
          severity: "warning",
        },
        {
          key: `online:${m.id}:${seen}`,
          type: "machine_recovered",
          title: `Machine back online: ${name}`,
          body: "Telemetry is reporting again.",
          href: "/machines",
          severity: "success",
        },
      );
    }
    const plans = await this.sql.query<{
      id: string;
      name: string;
      frequency: string;
      created_at: number;
      latest: number | null;
      latest_id: string | null;
    }>(
      "SELECT p.id,p.frequency,p.created_at,s.name,(SELECT MAX(j.updated_at) FROM ephor_backup_job j WHERE j.plan_id=p.id AND j.action='backup' AND j.status='succeeded') AS latest,(SELECT j.id FROM ephor_backup_job j WHERE j.plan_id=p.id AND j.action='backup' AND j.status='succeeded' ORDER BY j.updated_at DESC,j.id DESC LIMIT 1) AS latest_id FROM ephor_backup_plan p JOIN ephor_service s ON s.id=p.service_id",
    );
    for (const p of plans) {
      if (!(await keepLease())) return;
      const baseline = Math.max(
        Number(p.latest ?? p.created_at),
        Number(settings.started_at),
      );
      const overdue =
        p.frequency !== "manual" &&
        this.clock() - baseline >
          (p.frequency === "weekly" ? 7 * DAY : DAY) + 3600000;
      await this.condition(
        `overdue:${p.id}`,
        overdue,
        {
          key: `overdue:${p.id}:${baseline}`,
          type: "backup_overdue",
          title: `Backup overdue: ${label(p.name)}`,
          body: "There is no recent verified backup within the scheduled interval plus one hour. Check the machine, schedule, and storage destination.",
          href: "/backups",
          severity: "warning",
        },
        p.frequency === "manual"
          ? undefined
          : {
              key: `backup-recovered:${p.latest_id}`,
              type: "backup_recovered",
              title: `Backup freshness restored: ${label(p.name)}`,
              body: "A recent verified backup is available again.",
              href: "/backups",
              severity: "success",
            },
        Number(p.latest ?? 0),
      );
    }
    // Repeat unresolved backup failures at most daily, even when no new jobs finish.
    const unresolved = await this.sql.query<{
      id: string;
      name: string;
      episode: string;
    }>(
      "SELECT c.id,c.episode,s.name FROM ephor_notification_condition c JOIN ephor_backup_plan p ON c.id='backup:' || p.id JOIN ephor_service s ON s.id=p.service_id WHERE c.active=1 AND c.notified_at <= $1",
      [this.clock() - DAY],
    );
    for (const c of unresolved) {
      if (!(await keepLease())) return;
      await this.condition(c.id, true, {
        key: c.episode,
        type: "backup_failed",
        title: `Backup failed: ${label(c.name)}`,
        body: "No successful backup has resolved this failure. Open Backups to inspect the last result.",
        href: "/backups",
        severity: "warning",
      });
    }
  }
  async deliver() {
    await retireSecurityAlerts(this.sql, this.clock());
    const config = await this.secrets.open<EmailConfig>(
      "settings",
      (await this.settingsRow()).config,
    );
    const now = this.clock();
    await this.sql.query(
      "UPDATE ephor_notification SET email_status='uncertain',error='DELIVERY_WINDOW_EXPIRED',email_config=NULL,lease_owner=NULL WHERE email_status IN ('queued','sending') AND first_attempt IS NOT NULL AND first_attempt <= $1 AND lease_until <= $2",
      [now - RETRY_WINDOW, now],
    );
    if (!config.enabled) {
      await this.sql.query(
        "UPDATE ephor_notification SET email_status='cancelled',email_config=NULL,error='EMAIL_DISABLED' WHERE email_status='queued' OR (email_status='sending' AND lease_until <= $1)",
        [now],
      );
      return;
    }
    const token = crypto.randomUUID();
    const [row] = await this.sql.query<Delivery>(
      "UPDATE ephor_notification SET email_status='sending',lease_owner=$1,lease_until=$2,attempts=attempts+1,first_attempt=COALESCE(first_attempt,$3),last_attempt=$3 WHERE id=(SELECT id FROM ephor_notification WHERE ((email_status='queued' AND next_attempt <= $3) OR (email_status='sending' AND lease_until <= $3)) ORDER BY created_at,id LIMIT 1) AND ((email_status='queued' AND next_attempt <= $3) OR (email_status='sending' AND lease_until <= $3)) RETURNING *",
      [token, now + 60000, now],
    );
    if (!row) return;
    let status = "sent",
      error: string | null = null,
      providerId: string | null = null,
      delay = 60000;
    try {
      const c = await this.secrets.open<EmailConfig & { origin: string }>(
        row.id,
        row.email_config,
      );
      const response = await this.send("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `Bearer ${c.apiKey}`,
          "content-type": "application/json",
          "Idempotency-Key": `ephor-notification/${row.id}`,
        },
        body: JSON.stringify({
          from: c.from,
          to: c.recipients,
          subject: `[Ephor] ${row.title}`,
          text: `${row.body}\n\nOpen Ephor: ${c.origin}${row.href}\n\nManage notifications: ${c.origin}/notifications/settings`,
        }),
      });
      if (response.ok) {
        const body = (await response.json()) as { id?: unknown };
        if (
          typeof body.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,100}$/.test(body.id)
        )
          throw new Error("Invalid provider receipt");
        providerId = body.id;
      } else {
        status =
          response.status === 429 ||
          response.status >= 500 ||
          response.status === 409
            ? "queued"
            : "failed";
        error =
          response.status === 429
            ? "RESEND_RATE_LIMITED"
            : [401, 403].includes(response.status)
              ? "RESEND_ACCESS_DENIED"
              : response.status >= 500
                ? "RESEND_UNAVAILABLE"
                : "RESEND_REJECTED";
        const retry = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retry) && retry > 0)
          delay = Math.min(3600000, Math.max(60000, retry * 1000));
        await response.body?.cancel();
      }
    } catch {
      status = "queued";
      error = "RESEND_UNAVAILABLE";
    }
    if (status === "queued" && Number(row.attempts) >= 5) {
      status = "uncertain";
      error = "DELIVERY_RETRIES_EXHAUSTED";
    }
    delay = Math.max(
      delay,
      Math.min(3600000, 60000 * 5 ** (Number(row.attempts) - 1)),
    );
    await this.sql.query(
      "UPDATE ephor_notification SET email_status=$1,error=$2,provider_id=$3,next_attempt=$4,lease_owner=NULL,lease_until=0,email_config=CASE WHEN $1='queued' THEN email_config ELSE NULL END WHERE id=$5 AND email_status='sending' AND lease_owner=$6",
      [status, error, providerId, this.clock() + delay, row.id, token],
    );
  }
  async tick() {
    const token = crypto.randomUUID(),
      start = this.clock();
    const locked = await this.sql.query(
      "UPDATE ephor_notification_runtime SET lease_owner=$1,lease_until=$2 WHERE id=1 AND lease_until <= $3 RETURNING id",
      [token, start + 180000, start],
    );
    if (!locked.length) return;
    let renewedAt = start;
    const keepLease = async () => {
      const now = this.clock();
      if (now - start >= 90000) return false;
      if (now - renewedAt < 30000) return true;
      const rows = await this.sql.query(
        "UPDATE ephor_notification_runtime SET lease_until=$1 WHERE id=1 AND lease_owner=$2 AND lease_until>$3 RETURNING id",
        [now + 180000, token, now],
      );
      if (!rows.length) return false;
      renewedAt = now;
      return true;
    };
    try {
      await this.collect(keepLease);
      for (let i = 0; i < 10 && (await keepLease()); i++) await this.deliver();
      await this.sql.query(
        "DELETE FROM ephor_notification WHERE created_at<$1 AND email_status NOT IN ('queued','sending')",
        [this.clock() - 90 * DAY],
      );
      await this.sql.query(
        "DELETE FROM ephor_notification_source WHERE processed_at<$1",
        [this.clock() - 90 * DAY],
      );
      await this.sql.query(
        "UPDATE ephor_notification_runtime SET last_run=$1 WHERE id=1 AND lease_owner=$2",
        [this.clock(), token],
      );
    } finally {
      await this.sql.query(
        "UPDATE ephor_notification_runtime SET lease_owner=NULL,lease_until=0 WHERE id=1 AND lease_owner=$1",
        [token],
      );
    }
  }
}
export async function processNotifications(
  env: Pick<AuthEnvironment, "sql" | "secret" | "origin">,
) {
  await maintainSecurity(env);
  await new Notifications(env.sql, env.secret, env.origin).tick();
}
