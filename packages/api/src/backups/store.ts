import { AuthError, AuthStore, randomToken, type Sql } from "../auth/store";
import { machineClaim } from "../machines/maintenance-lock";
import { template } from "../services/catalog";
import { ServiceSecrets } from "../services/crypto";
import { readDomains } from "../services/domains";
import {
  isStateful,
  object,
  requiredProtocol,
  type ServiceSpec,
  serviceId,
} from "../services/spec";
import { Services } from "../services/store";
import {
  type DestinationConfig,
  destinationConfig,
  nextRun,
  schedule,
} from "./providers";

interface Destination extends Record<string, unknown> {
  id: string;
  name: string;
  config: string;
  status: string;
  checked_machine: string;
  check_password: string;
}
interface Plan extends Record<string, unknown> {
  id: string;
  service_id: string;
  destination_id: string;
  password: string;
  frequency: string;
  hour: number;
  next_run: number;
}
interface BackupJob extends Record<string, unknown> {
  id: string;
  machine_id: string;
  service_id: string | null;
  plan_id: string | null;
  destination_id: string;
  action: string;
  payload: string;
  status: string;
  snapshot_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
interface LocalJob {
  id: string;
  serviceId: string;
  domain: string | null;
  domains: ReturnType<typeof readDomains>;
  action: string;
  spec: ServiceSpec;
}
interface Payload {
  repository: string;
  password: string;
  job?: LocalJob;
  snapshot?: string;
  sourceServiceId?: string;
  architecture?: string;
}
export class Backups {
  readonly secrets: ServiceSecrets;
  readonly services: Services;
  constructor(
    private sql: Sql,
    secret: string,
  ) {
    this.secrets = new ServiceSecrets(`backup:${secret}`);
    this.services = new Services(sql, secret);
  }
  async ready(machine: unknown, minimum = 4) {
    const id = serviceId(machine);
    const [row] = await this.sql.query(
      "SELECT m.id FROM ephor_machine m JOIN ephor_service_worker w ON w.machine_id=m.id WHERE m.id=$1 AND m.state='active' AND w.version IN ('4','5','6') AND CAST(w.version AS INTEGER)>=$3 AND w.last_seen>$2",
      [id, Date.now() - 120000, minimum],
    );
    if (!row) throw new AuthError("BACKUP_WORKER_REQUIRED", 409);
    return id;
  }
  async destination(id: unknown) {
    const [row] = await this.sql.query<Destination>(
      "SELECT * FROM ephor_backup_destination WHERE id=$1",
      [serviceId(id)],
    );
    if (!row) throw new AuthError("BACKUP_DESTINATION_NOT_FOUND", 404);
    return row;
  }
  async plan(id: unknown) {
    const [row] = await this.sql.query<Plan>(
      "SELECT * FROM ephor_backup_plan WHERE id=$1",
      [serviceId(id)],
    );
    if (!row) throw new AuthError("BACKUP_PLAN_NOT_FOUND", 404);
    return row;
  }
  async insert(
    machine: string,
    destination: string,
    action: string,
    payload: Payload,
    service: string | null = null,
    plan: string | null = null,
    key: string | null = null,
    id = crypto.randomUUID() as string,
  ) {
    const rows = await this.sql.query(
      "INSERT INTO ephor_backup_job (id,machine_id,service_id,plan_id,destination_id,action,payload,status,created_at,updated_at,schedule_key,protocol) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id",
      [
        id,
        machine,
        service,
        plan,
        destination,
        action,
        await this.secrets.seal(id, payload),
        Date.now(),
        key,
        Math.max(4, payload.job ? requiredProtocol(payload.job.spec) : 4),
      ],
    );
    if (!rows.length) throw new AuthError("BACKUP_ALREADY_RUNNING", 409);
    await new AuthStore(this.sql).audit(`backup.${action}_requested`, id);
    return { id };
  }
  async createDestination(body: unknown) {
    const b = object(body),
      config = destinationConfig(b),
      machine = await this.ready(b.machineId);
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80)
      throw new AuthError("INVALID_BACKUP_DESTINATION");
    const id = crypto.randomUUID(),
      password = randomToken();
    await this.sql.query(
      "INSERT INTO ephor_backup_destination (id,name,config,status,checked_machine,check_password,created_at) VALUES ($1,$2,$3,'pending',$4,$5,$6)",
      [
        id,
        b.name.trim(),
        await this.secrets.seal(id, config),
        machine,
        await this.secrets.seal(`${id}:check`, password),
        Date.now(),
      ],
    );
    await this.checkDestination(id, machine);
    return { id };
  }
  async checkDestination(id: unknown, machine: unknown) {
    const d = await this.destination(id),
      m = await this.ready(machine);
    const active = await this.sql.query(
      "SELECT id FROM ephor_backup_job WHERE destination_id=$1 AND action='check' AND status IN ('queued','running')",
      [d.id],
    );
    if (active.length) throw new AuthError("BACKUP_ALREADY_RUNNING", 409);
    await this.sql.query(
      "UPDATE ephor_backup_destination SET status='pending',checked_machine=$2 WHERE id=$1",
      [d.id, m],
    );
    return this.insert(m, d.id, "check", {
      repository: `ephor/${d.id}/check`,
      password: await this.secrets.open<string>(
        `${d.id}:check`,
        d.check_password,
      ),
    });
  }
  async credentials(id: unknown, body: unknown) {
    const d = await this.destination(id),
      b = object(body),
      machine = await this.ready(b.machineId);
    if (
      (
        await this.sql.query(
          "SELECT id FROM ephor_backup_job WHERE destination_id=$1 AND status IN ('queued','running')",
          [d.id],
        )
      ).length
    )
      throw new AuthError("BACKUP_ALREADY_RUNNING", 409);
    const old = await this.secrets.open<DestinationConfig>(d.id, d.config);
    const jurisdiction = new URL(old.endpoint).hostname.split(".")[1];
    const config = destinationConfig({
      ...old,
      jurisdiction: ["eu", "us", "fedramp"].includes(jurisdiction ?? "")
        ? jurisdiction
        : "default",
      accountId: new URL(old.endpoint).hostname.split(".")[0],
      accessKey: b.accessKey,
      secretKey: b.secretKey,
    });
    await this.sql.query(
      "UPDATE ephor_backup_destination SET config=$1,status='pending' WHERE id=$2",
      [await this.secrets.seal(d.id, config), d.id],
    );
    await new AuthStore(this.sql).audit("backup.credentials_changed", d.id);
    return this.checkDestination(d.id, machine);
  }
  async configure(body: unknown) {
    const b = object(body),
      s = await this.services.get(b.serviceId),
      d = await this.destination(b.destinationId),
      timing = schedule(b);
    const spec = await this.services.secrets.open<ServiceSpec>(s.id, s.config);
    if (!isStateful(spec)) throw new AuthError("NOT_A_CATALOG_APP");
    const [old] = await this.sql.query<Plan>(
      "SELECT * FROM ephor_backup_plan WHERE service_id=$1",
      [s.id],
    );
    if (d.status !== "ready" && !(old && timing.frequency === "manual"))
      throw new AuthError("BACKUP_DESTINATION_NOT_READY", 409);
    if (old && old.destination_id !== d.id)
      throw new AuthError("BACKUP_DESTINATION_LOCKED", 409);
    if (!old)
      await this.ready(s.machine_id, Math.max(4, requiredProtocol(spec)));
    const id = old?.id ?? crypto.randomUUID();
    const saved = await this.sql.query<{ id: string }>(
      "INSERT INTO ephor_backup_plan (id,service_id,destination_id,password,frequency,hour,next_run,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(service_id) DO UPDATE SET frequency=$5,hour=$6,next_run=$7 WHERE ephor_backup_plan.destination_id=$3 RETURNING id",
      [
        id,
        s.id,
        d.id,
        old?.password ?? (await this.secrets.seal(id, randomToken())),
        timing.frequency,
        timing.hour,
        nextRun(timing.frequency, timing.hour),
        Date.now(),
      ],
    );
    if (!saved[0]) throw new AuthError("BACKUP_DESTINATION_LOCKED", 409);
    await new AuthStore(this.sql).audit("backup.schedule_changed", saved[0].id);
    return { id: saved[0].id };
  }
  async queue(id: unknown, scheduled?: number) {
    const p = await this.plan(id),
      s = await this.services.get(p.service_id),
      d = await this.destination(p.destination_id);
    if (d.status !== "ready")
      throw new AuthError("BACKUP_DESTINATION_NOT_READY", 409);
    if (scheduled === undefined) await this.ready(s.machine_id);
    const [busy] = await this.sql.query(
      "SELECT id FROM ephor_deployment WHERE service_id=$1 AND status IN ('queued','running')",
      [s.id],
    );
    if (busy) throw new AuthError("DEPLOYMENT_ALREADY_RUNNING", 409);
    const deployed = await this.services.deployedSnapshot(s);
    const spec = deployed?.spec;
    if (!spec || !isStateful(spec))
      throw new AuthError("BACKUP_APP_NOT_READY", 409);
    const [machine] = await this.sql.query<{ telemetry: string | null }>(
      "SELECT telemetry FROM ephor_machine WHERE id=$1",
      [s.machine_id],
    );
    const architecture = JSON.parse(machine?.telemetry ?? "{}").arch;
    if (!["x86_64", "aarch64"].includes(architecture))
      throw new AuthError("MACHINE_ARCHITECTURE_REQUIRED", 409);
    if (scheduled === undefined)
      await this.ready(s.machine_id, Math.max(4, requiredProtocol(spec)));
    const jid = crypto.randomUUID();
    const payload: Payload = {
      architecture,
      repository: `ephor/${d.id}/${p.id}`,
      password: await this.secrets.open<string>(p.id, p.password),
      job: {
        id: jid,
        serviceId: s.id,
        domain: deployed.domains.primary,
        domains: deployed.domains,
        action: "backup",
        spec,
      },
    };
    return this.insert(
      s.machine_id,
      d.id,
      "backup",
      payload,
      s.id,
      p.id,
      scheduled === undefined ? null : `${p.id}:${scheduled}`,
      jid,
    );
  }
  async tick(machine: string) {
    const plans = await this.sql.query<Plan>(
      "SELECT p.* FROM ephor_backup_plan p JOIN ephor_service s ON s.id=p.service_id WHERE s.machine_id=$1 AND p.next_run>0 AND p.next_run<=$2 ORDER BY p.next_run LIMIT 50",
      [machine, Date.now()],
    );
    for (const p of plans) {
      const [existing] = await this.sql.query(
        "SELECT id FROM ephor_backup_job WHERE schedule_key=$1",
        [`${p.id}:${p.next_run}`],
      );
      try {
        if (!existing) await this.queue(p.id, Number(p.next_run));
      } catch (e) {
        if (
          e instanceof AuthError &&
          [
            "BACKUP_ALREADY_RUNNING",
            "DEPLOYMENT_ALREADY_RUNNING",
            "BACKUP_APP_NOT_READY",
            "BACKUP_DESTINATION_NOT_READY",
            "MACHINE_ARCHITECTURE_REQUIRED",
          ].includes(e.code)
        )
          continue;
        throw e;
      }
      await this.sql.query(
        "UPDATE ephor_backup_plan SET next_run=$1 WHERE id=$2 AND next_run=$3",
        [nextRun(p.frequency, Number(p.hour)), p.id, p.next_run],
      );
    }
  }
  async restore(body: unknown) {
    const b = object(body),
      machine = await this.ready(b.machineId);
    const [source] = await this.sql.query<BackupJob>(
      "SELECT * FROM ephor_backup_job WHERE id=$1 AND action='backup' AND status='succeeded'",
      [serviceId(b.backupId)],
    );
    if (!source?.snapshot_id) throw new AuthError("BACKUP_NOT_FOUND", 404);
    const original = await this.secrets.open<Payload>(
      source.id,
      source.payload,
    );
    if (!original.job || !isStateful(original.job.spec))
      throw new AuthError("BACKUP_NOT_FOUND", 404);
    await this.ready(machine, Math.max(4, requiredProtocol(original.job.spec)));
    // Same physical database files require the same architecture, even when the image is multi-platform.
    const [targetMachine] = await this.sql.query<{ telemetry: string | null }>(
      "SELECT telemetry FROM ephor_machine WHERE id=$1",
      [machine],
    );
    const architecture = JSON.parse(targetMachine?.telemetry ?? "{}").arch;
    if (!original.architecture || original.architecture !== architecture)
      throw new AuthError("BACKUP_ARCHITECTURE_MISMATCH", 409);
    const recipe = original.job.spec.catalog
      ? template(
          original.job.spec.catalog.template,
          original.job.spec.catalog.version,
        )
      : { web: false };
    if (recipe.web && !b.domain) throw new AuthError("CATALOG_DOMAIN_REQUIRED");
    if (!recipe.web && b.domain)
      throw new AuthError("DATABASE_MUST_BE_PRIVATE");
    const config = structuredClone(original.job.spec);
    if (original.job.spec.catalog)
      config.catalog = { ...original.job.spec.catalog, protected: recipe.web };
    // Restored custom applications are private and detached from production dependencies.
    delete config.connections;
    const sourceService = await this.services.get(original.job.serviceId);
    const created = await this.services.create(
      { machineId: machine, name: b.name, domain: b.domain, spec: config },
      config.catalog ? JSON.parse(sourceService.source) : { type: "image" },
    );
    const jid = crypto.randomUUID();
    try {
      const target = await this.services.get(created.id);
      await this.insert(
        machine,
        source.destination_id,
        "restore",
        {
          ...original,
          snapshot: source.snapshot_id,
          sourceServiceId: original.job.serviceId,
          job: {
            id: jid,
            serviceId: target.id,
            domain: target.domain,
            domains: readDomains(target),
            action: "deploy",
            spec: config,
          },
        },
        target.id,
        source.plan_id,
        null,
        jid,
      );
    } catch (e) {
      await this.sql.query(
        "DELETE FROM ephor_service_domain WHERE service_id=$1",
        [created.id],
      );
      await this.sql.query("DELETE FROM ephor_service WHERE id=$1", [
        created.id,
      ]);
      throw e;
    }
    return { id: jid, serviceId: created.id };
  }
  async next(machine: string, protocol: unknown) {
    if (protocol !== 4 && protocol !== 5 && protocol !== 6)
      throw new AuthError("BACKUP_WORKER_REQUIRED", 409);
    await this.services.heartbeat(machine, Number(protocol));
    await this.tick(machine);
    // A running job is never reassigned to a different machine or expired by a timer.
    await machineClaim(this.sql, machine, async () =>
      this.sql.query(
        "UPDATE ephor_backup_job SET status='running',updated_at=$1 WHERE id=(SELECT id FROM ephor_backup_job WHERE machine_id=$2 AND status='queued' AND protocol <= $3 ORDER BY created_at,id LIMIT 1) AND status='queued' AND NOT EXISTS (SELECT 1 FROM ephor_backup_job WHERE machine_id=$2 AND status='running') AND NOT EXISTS (SELECT 1 FROM ephor_deployment WHERE machine_id=$2 AND status='running') AND NOT EXISTS (SELECT 1 FROM ephor_update WHERE machine_id=$2 AND ((status IN ('queued','downloading') AND expires_at>$1) OR status='installing' OR (status='expired' AND install_started=1))) AND NOT EXISTS (SELECT 1 FROM ephor_machine WHERE id=$2 AND maintenance_until>$1) RETURNING id",
        [Date.now(), machine, protocol],
      ),
    );
    const [job] = await this.sql.query<BackupJob>(
      "SELECT * FROM ephor_backup_job WHERE machine_id=$1 AND status='running'",
      [machine],
    );
    if (!job) return null;
    const payload = await this.secrets.open<Payload>(job.id, job.payload);
    if (payload.job && requiredProtocol(payload.job.spec) > Number(protocol))
      return null;
    const d = await this.destination(job.destination_id);
    return {
      id: job.id,
      action: job.action,
      ...(await this.secrets.open<Payload>(job.id, job.payload)),
      destination: await this.secrets.open<DestinationConfig>(d.id, d.config),
    };
  }
  async report(machine: string, body: unknown) {
    const b = object(body),
      id = serviceId(b.id);
    if (!["succeeded", "failed"].includes(String(b.status)))
      throw new AuthError("INVALID_BACKUP_REPORT");
    const [job] = await this.sql.query<BackupJob>(
      "SELECT * FROM ephor_backup_job WHERE id=$1 AND machine_id=$2",
      [id, machine],
    );
    if (!job || !["running", String(b.status)].includes(job.status))
      throw new AuthError("BACKUP_NOT_ACTIVE", 409);
    if (job.status !== "running") return;
    if (
      b.status === "succeeded" &&
      job.action === "backup" &&
      (typeof b.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(b.snapshot))
    )
      throw new AuthError("INVALID_BACKUP_REPORT");
    if (job.action === "check")
      await this.sql.query(
        "UPDATE ephor_backup_destination SET status=$1 WHERE id=$2",
        [b.status === "succeeded" ? "ready" : "failed", job.destination_id],
      );
    if (job.action === "restore" && b.status === "succeeded")
      await this.sql.query(
        "UPDATE ephor_service SET current_deployment=$1 WHERE id=$2",
        [id, job.service_id],
      );
    const errors = [
      "BACKUP_INTERRUPTED",
      "BACKUP_STORAGE_FAILED",
      "BACKUP_APP_FAILED",
      "BACKUP_RECIPE_MISMATCH",
      "BACKUP_RESTORE_FAILED",
      "BACKUP_WORKER_REQUIRED",
    ];
    await this.sql.query(
      "UPDATE ephor_backup_job SET status=$1,snapshot_id=$2,error=$3,updated_at=$4 WHERE id=$5 AND status='running'",
      [
        b.status,
        b.status === "succeeded" && job.action === "backup" ? b.snapshot : null,
        b.status === "failed"
          ? errors.includes(String(b.error))
            ? b.error
            : "BACKUP_STORAGE_FAILED"
          : null,
        Date.now(),
        id,
      ],
    );
    await new AuthStore(this.sql).audit(`backup.${job.action}_${b.status}`, id);
  }
  async list() {
    const destinations = await this.sql.query<Destination>(
      "SELECT * FROM ephor_backup_destination ORDER BY created_at DESC",
    );
    return {
      destinations: await Promise.all(
        destinations.map(async (d) => {
          const c = await this.secrets.open<DestinationConfig>(d.id, d.config);
          return {
            id: d.id,
            name: d.name,
            status: d.status,
            machineId: d.checked_machine,
            provider: c.provider,
            bucket: c.bucket,
            endpoint: c.endpoint,
            region: c.region,
          };
        }),
      ),
      plans: (
        await this.sql.query(
          `SELECT p.id,p.service_id,p.destination_id,p.frequency,p.hour,p.next_run,p.created_at,
            (SELECT MAX(j.updated_at) FROM ephor_backup_job j WHERE j.plan_id=p.id AND j.action='backup' AND j.status='succeeded') AS last_success,
            (SELECT j.status FROM ephor_backup_job j WHERE j.plan_id=p.id AND j.action='backup' AND j.status IN ('succeeded','failed') ORDER BY j.updated_at DESC,j.id DESC LIMIT 1) AS last_status
           FROM ephor_backup_plan p`,
        )
      ).map((p) => ({
        ...p,
        hour: Number(p.hour),
        next_run: Number(p.next_run),
        created_at: Number(p.created_at),
        last_success: p.last_success == null ? null : Number(p.last_success),
        last_status: p.last_status == null ? null : String(p.last_status),
      })),
      jobs: (
        await this.sql.query<BackupJob>(
          "SELECT id,machine_id,service_id,plan_id,destination_id,action,status,snapshot_id,error,created_at,updated_at FROM ephor_backup_job ORDER BY created_at DESC LIMIT 500",
        )
      ).map((j) => ({
        ...j,
        created_at: Number(j.created_at),
        updated_at: Number(j.updated_at),
      })),
    };
  }
  async recovery(id: unknown) {
    const p = await this.plan(id),
      d = await this.destination(p.destination_id),
      c = await this.secrets.open<DestinationConfig>(d.id, d.config);
    await new AuthStore(this.sql).audit("backup.recovery_exported", p.id);
    return {
      format: "ephor-restic-recovery-v1",
      repository: `s3:${c.endpoint}/${c.bucket}/ephor/${d.id}/${p.id}`,
      password: await this.secrets.open<string>(p.id, p.password),
      region: c.region,
      accessKey: c.accessKey,
      secretKey: c.secretKey,
      instructions:
        "Keep this file in a password manager, away from your servers. With Restic installed, set RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION from these values. Run restic snapshots, then restic restore <snapshot-id> --target ./recovered --verify. The recovered data/manifest.json contains the pinned recipe and app credentials; data/volumes contains checksummed cold archives. See docs/backups.md for app recovery. Storage account recovery is independent of Ephor.",
    };
  }
}
