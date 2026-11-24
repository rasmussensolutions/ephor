import {
  AuthError,
  AuthStore,
  hash,
  randomToken,
  type Sql,
} from "../auth/store";
import { machineClaim } from "../machines/maintenance-lock";
import { readCatalogRuntime, template } from "./catalog";
import { ServiceConnections, variableConnections } from "./connections";
import { ServiceSecrets } from "./crypto";
import { readDomains, reserveDomains } from "./domains";
import { readMetrics, recordMetrics, type ServiceRuntime } from "./metrics";
import {
  buildSettings,
  domainName,
  isStateful,
  object,
  publicSpec,
  requiredProtocol,
  type ServiceDomains,
  type ServiceSource,
  type ServiceSpec,
  serviceId,
  spec,
} from "./spec";
import { topology } from "./topology";

export interface ServiceRow extends Record<string, unknown> {
  id: string;
  machine_id: string;
  name: string;
  group_name: string | null;
  group_color: string;
  component_names: string;
  domain: string | null;
  domains?: string | null;
  config: string;
  source: string;
  created_at: number;
  runtime: string | null;
  runtime_at: number | null;
  auto_deploy: number;
  last_run: number;
  current_deployment: string | null;
}
export interface DeploymentRow extends Record<string, unknown> {
  id: string;
  service_id: string;
  machine_id: string;
  action: string;
  spec: string;
  status: string;
  created_at: number;
  updated_at: number;
  source_ref: string | null;
  digest: string | null;
  error: string | null;
  domains?: string | null;
  protocol: number;
  backup_id: string | null;
}
export class Services {
  readonly secrets: ServiceSecrets;
  private readonly backupSecrets: ServiceSecrets;
  constructor(
    private sql: Sql,
    secret: string,
  ) {
    this.secrets = new ServiceSecrets(secret);
    this.backupSecrets = new ServiceSecrets(`backup:${secret}`);
  }
  async deployedSnapshot(
    row: ServiceRow,
  ): Promise<{ spec: ServiceSpec; domains: ServiceDomains } | null> {
    if (!row.current_deployment) return null;
    const [deployment] = await this.sql.query<DeploymentRow>(
      "SELECT * FROM ephor_deployment WHERE id=$1 AND service_id=$2",
      [row.current_deployment, row.id],
    );
    if (deployment) {
      const config = await this.secrets.open<ServiceSpec>(
        deployment.id,
        deployment.spec,
      );
      if (deployment.digest) config.image = deployment.digest;
      return {
        spec: config,
        domains: readDomains({
          domain: row.domain,
          domains: deployment.domains,
        }),
      };
    }
    // Offsite restores have their own durable receipt rather than a deployment row.
    const [restore] = await this.sql.query<{ id: string; payload: string }>(
      "SELECT id,payload FROM ephor_backup_job WHERE id=$1 AND service_id=$2 AND action='restore' AND status IN ('running','succeeded')",
      [row.current_deployment, row.id],
    );
    if (!restore) return null;
    const payload = await this.backupSecrets.open<{
      job?: {
        spec: ServiceSpec;
        domains: ServiceDomains;
        domain: string | null;
      };
    }>(restore.id, restore.payload);
    return payload.job
      ? {
          spec: payload.job.spec,
          domains: payload.job.domains ?? {
            primary: payload.job.domain,
            aliases: [],
            redirect: false,
          },
        }
      : null;
  }
  async get(id: unknown) {
    const [row] = await this.sql.query<ServiceRow>(
      "SELECT * FROM ephor_service WHERE id = $1",
      [serviceId(id)],
    );
    if (!row) throw new AuthError("SERVICE_NOT_FOUND", 404);
    return row;
  }
  async create(body: unknown, source: ServiceSource) {
    const b = object(body),
      id = crypto.randomUUID(),
      config = spec(b.spec);
    if ((source.type === "catalog") !== !!config.catalog)
      throw new AuthError("INVALID_CATALOG_CONFIG");
    const machineId = serviceId(b.machineId),
      domain = domainName(b.domain);
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80)
      throw new AuthError("INVALID_SERVICE_NAME");
    const [machine] = await this.sql.query<{ telemetry: string | null }>(
      "SELECT telemetry FROM ephor_machine WHERE id=$1 AND state='active'",
      [machineId],
    );
    if (!machine) throw new AuthError("MACHINE_NOT_FOUND", 404);
    await new ServiceConnections(this.sql, this.secrets).resolve(
      { id, machine_id: machineId },
      config,
    );
    if (source.type === "github") {
      const architecture = JSON.parse(machine.telemetry ?? "{}").arch;
      if (!["x86_64", "aarch64"].includes(architecture))
        throw new AuthError("MACHINE_ARCHITECTURE_REQUIRED", 409);
      source = { ...source, architecture };
      config.image = source.installationId
        ? `ephor.local/${id}:pending`
        : `ghcr.io/${source.repository?.toLowerCase()}/ephor-${id}:latest`;
      if (source.installationId) config.registry = null;
    }
    if (
      (
        await this.sql.query(
          "SELECT id FROM ephor_service WHERE machine_id = $1",
          [machineId],
        )
      ).length >= 50
    )
      throw new AuthError("SERVICE_LIMIT", 409);
    const rows = await this.sql.query(
      "INSERT INTO ephor_service (id,machine_id,name,domain,config,source,created_at,auto_deploy,group_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$3) ON CONFLICT DO NOTHING RETURNING id",
      [
        id,
        machineId,
        b.name.trim(),
        domain,
        await this.secrets.seal(id, config),
        JSON.stringify(source),
        Date.now(),
        source.type === "github" && b.autoDeploy !== false ? 1 : 0,
      ],
    );
    if (!rows.length) throw new AuthError("DOMAIN_IN_USE", 409);
    try {
      await reserveDomains(
        this.sql,
        id,
        b.domains ?? { primary: domain, aliases: [], redirect: false },
      );
    } catch (error) {
      await this.sql.query(
        "DELETE FROM ephor_service_domain WHERE service_id=$1",
        [id],
      );
      await this.sql.query("DELETE FROM ephor_service WHERE id=$1", [id]);
      throw error;
    }
    await new AuthStore(this.sql).audit("service.created", id);
    return { id };
  }
  async configure(id: unknown, body: unknown, replacement?: ServiceSource) {
    const row = await this.get(id),
      b = object(body),
      old = await this.secrets.open<ServiceSpec>(row.id, row.config);
    if (old.catalog) throw new AuthError("CATALOG_CONFIG_LOCKED", 409);
    const update = object(b.spec);
    const config = spec({
      ...update,
      volumes: update.volumes ?? old.volumes,
      environment: update.environment ?? old.environment,
      registry: update.registry === undefined ? old.registry : update.registry,
    });
    if (config.catalog) throw new AuthError("INVALID_CATALOG_CONFIG");
    if (
      JSON.stringify(config.volumes ?? []) !==
        JSON.stringify(old.volumes ?? []) &&
      (row.current_deployment ||
        (
          await this.sql.query(
            "SELECT id FROM ephor_deployment WHERE service_id=$1 LIMIT 1",
            [row.id],
          )
        ).length)
    )
      throw new AuthError("VOLUME_LAYOUT_LOCKED", 409);
    const previousSource = JSON.parse(row.source) as ServiceSource;
    await new ServiceConnections(this.sql, this.secrets).resolve(row, config);
    if (replacement && replacement.type !== previousSource.type)
      throw new AuthError("INVALID_REPOSITORY");
    const source = replacement
      ? { ...replacement, architecture: previousSource.architecture }
      : previousSource;
    if (b.buildSettings !== undefined) {
      if (source.type !== "github")
        throw new AuthError("NOT_A_REPOSITORY_SERVICE");
      delete source.buildMachineId;
      Object.assign(source, buildSettings(object(b.buildSettings)));
    }
    if (b.domains !== undefined)
      await reserveDomains(this.sql, row.id, b.domains);
    await this.sql.query(
      "UPDATE ephor_service SET config = $1, auto_deploy = $2, source = $4 WHERE id = $3",
      [
        await this.secrets.seal(row.id, config),
        b.autoDeploy === undefined
          ? row.auto_deploy
          : b.autoDeploy === true
            ? 1
            : 0,
        row.id,
        JSON.stringify(source),
      ],
    );
    await new AuthStore(this.sql).audit("service.configured", row.id);
  }
  async list(id?: string, summary = false) {
    const rows = await this.sql.query<ServiceRow>(
      `SELECT * FROM ephor_service ${id ? "WHERE id=$1" : ""} ORDER BY created_at DESC LIMIT 1000`,
      id ? [id] : [],
    );
    const positions = await this.sql.query<{
      service_id: string;
      component_id: string;
      revision: number;
      x: number;
      y: number;
    }>(
      `SELECT * FROM ephor_service_map_position ${id ? "WHERE service_id=$1" : ""}`,
      id ? [id] : [],
    );
    const layouts = new Map<
      string,
      Record<string, { x: number; y: number; revision: number }>
    >();
    for (const position of positions) {
      const layout = layouts.get(position.service_id) ?? {};
      layout[position.component_id] = {
        revision: Number(position.revision),
        x: Number(position.x),
        y: Number(position.y),
      };
      layouts.set(position.service_id, layout);
    }
    const deployments = await this.sql.query<
      Pick<DeploymentRow, "id" | "spec" | "action">
    >(
      `SELECT d.id,d.spec,d.action FROM ephor_deployment d JOIN ephor_service s ON s.current_deployment=d.id ${id ? "WHERE s.id=$1" : ""}`,
      id ? [id] : [],
    );
    const current = new Map(deployments.map((d) => [d.id, d]));
    const connections = new ServiceConnections(this.sql, this.secrets);
    return Promise.all(
      rows.map(async (row) => {
        const config = await this.secrets.open<ServiceSpec>(row.id, row.config);
        const deployment = current.get(row.current_deployment ?? "");
        const deployed =
          deployment && deployment.action !== "stop"
            ? await this.secrets.open<ServiceSpec>(
                deployment.id,
                deployment.spec,
              )
            : !deployment && row.current_deployment
              ? ((await this.deployedSnapshot(row))?.spec ?? null)
              : null;
        const runtime: ServiceRuntime | null = row.runtime
          ? JSON.parse(row.runtime)
          : null;
        if (summary && runtime) {
          runtime.logs = "";
          for (const component of runtime.catalog?.components ?? [])
            delete component.logs;
        }
        return {
          id: row.id,
          machineId: row.machine_id,
          name: row.name,
          presentation: {
            ...(layouts.has(row.id) ? { positions: layouts.get(row.id) } : {}),
            groupName: row.group_name ?? row.name,
            groupColor: row.group_color ?? "neutral",
            componentNames: JSON.parse(row.component_names ?? "{}") as Record<
              string,
              string
            >,
          },
          domain: row.domain,
          domains: readDomains(row),
          spec: publicSpec(config),
          variableConnections: variableConnections(config),
          requiredWorkerProtocol: requiredProtocol(config, true),
          variablesPending: await connections.pending(row, config, deployed),
          resourcesPending:
            !!config.catalog?.resources &&
            (!row.current_deployment ||
              ((!!deployment || !!deployed) &&
                (config.catalog.resources.memoryMb !==
                  deployed?.catalog?.resources?.memoryMb ||
                  config.catalog.resources.cpus !==
                    deployed?.catalog?.resources?.cpus ||
                  config.catalog.resources.redisMaxmemoryMb !==
                    deployed?.catalog?.resources?.redisMaxmemoryMb))),
          ...(config.catalog ? { topology: topology(config.catalog) } : {}),
          source: JSON.parse(row.source) as ServiceSource,
          createdAt: Number(row.created_at),
          runtime,
          runtimeAt: Number(row.runtime_at || 0),
          autoDeploy: row.auto_deploy === 1,
          currentDeployment: row.current_deployment,
        };
      }),
    );
  }
  async history(id?: string) {
    const rows = await this.sql.query<DeploymentRow>(
      `SELECT id,service_id,machine_id,action,status,created_at,updated_at,source_ref,digest,error FROM ephor_deployment ${id ? "WHERE service_id=$1" : ""} ORDER BY created_at DESC LIMIT 500`,
      id ? [id] : [],
    );
    return rows.map((r) => ({
      ...r,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    }));
  }
  async queue(
    id: unknown,
    action: string,
    options: {
      deploymentId?: unknown;
      backupId?: unknown;
      image?: string;
      delivery?: string;
      run?: number;
      sha?: string;
      approvedConfig?: string;
    } = {},
  ) {
    const row = await this.get(id);
    if (options.approvedConfig && options.approvedConfig !== row.config)
      throw new AuthError("MCP_STATE_CHANGED", 409);
    if (
      (
        await this.sql.query(
          "SELECT id FROM ephor_backup_job WHERE service_id=$1 AND status IN ('queued','running')",
          [row.id],
        )
      ).length
    )
      throw new AuthError("BACKUP_ALREADY_RUNNING", 409);
    if (
      ![
        "deploy",
        "rollback",
        "stop",
        "backup",
        "restore",
        "delete-backup",
      ].includes(action)
    )
      throw new AuthError("INVALID_SERVICE_ACTION");
    let config = await this.secrets.open<ServiceSpec>(row.id, row.config);
    let domains = readDomains(row);
    if (
      config.catalog &&
      (action === "rollback" || options.image || options.delivery)
    )
      throw new AuthError("CATALOG_ROLLBACK_BLOCKED", 409);
    if (config.volumes?.length && action === "rollback")
      throw new AuthError("STATEFUL_ROLLBACK_BLOCKED", 409);
    // Maintenance must use the deployed image and resolved variables, never pending settings.
    if (
      isStateful(config) &&
      ["stop", "backup", "restore", "delete-backup"].includes(action) &&
      row.current_deployment
    ) {
      const current = await this.deployedSnapshot(row);
      if (!current) throw new AuthError("BACKUP_APP_NOT_READY", 409);
      config = current.spec;
      domains = current.domains;
    }
    if (
      ["backup", "restore", "delete-backup"].includes(action) &&
      !isStateful(config)
    )
      throw new AuthError("NOT_A_CATALOG_APP");
    if (["restore", "delete-backup"].includes(action))
      serviceId(options.backupId);
    if (options.delivery) {
      const [existing] = await this.sql.query<{ id: string }>(
        "SELECT id FROM ephor_deployment WHERE delivery = $1",
        [options.delivery],
      );
      if (existing) return { id: existing.id };
      const [newer] = await this.sql.query(
        "SELECT id FROM ephor_deployment WHERE service_id=$1 AND run_number >= $2 AND run_number > 0 LIMIT 1",
        [row.id, options.run ?? 0],
      );
      if (!row.auto_deploy || newer)
        throw new AuthError("AUTO_DEPLOY_DISABLED_OR_STALE", 409);
    }
    if (action === "rollback") {
      const [previous] = await this.sql.query<DeploymentRow>(
        "SELECT * FROM ephor_deployment WHERE id=$1 AND service_id=$2 AND status='succeeded' AND action <> 'stop'",
        [serviceId(options.deploymentId), row.id],
      );
      if (!previous?.digest) throw new AuthError("ROLLBACK_UNAVAILABLE", 409);
      config = await this.secrets.open<ServiceSpec>(previous.id, previous.spec);
      config.image = previous.digest;
    }
    if (options.image) config = spec({ ...config, image: options.image });
    if (action === "deploy")
      config = await new ServiceConnections(this.sql, this.secrets).resolve(
        row,
        config,
      );
    const protocol = requiredProtocol(config);
    const [ready] = await this.sql.query(
      "SELECT w.machine_id FROM ephor_service_worker w JOIN ephor_machine m ON m.id=w.machine_id WHERE w.machine_id=$1 AND m.state='active' AND w.last_seen > $2 AND w.version IN ('2','3','4','5','6') AND CAST(w.version AS INTEGER)>=$3 AND w.credential_hash IS NOT NULL",
      [row.machine_id, Date.now() - 120000, protocol],
    );
    if (!ready)
      throw new AuthError(
        protocol === 6
          ? "STATEFUL_WORKER_REQUIRED"
          : protocol === 5
            ? "CONNECTION_WORKER_REQUIRED"
            : config.catalog
              ? "CATALOG_WORKER_REQUIRED"
              : "SERVICE_WORKER_REQUIRED",
        409,
      );
    const jobId = crypto.randomUUID(),
      now = Date.now();
    const inserted = await this.sql.query(
      "INSERT INTO ephor_deployment (id,service_id,machine_id,action,spec,status,created_at,updated_at,source_ref,delivery,run_number,domains,protocol,backup_id) SELECT $1,id,machine_id,$3,$4,'queued',$5,$5,$6,$7,$8,$9,$10,$11 FROM ephor_service WHERE id=$2 AND config=$12 AND source=$13 AND COALESCE(domains,'')=$14 AND EXISTS (SELECT 1 FROM ephor_machine WHERE id=machine_id AND state='active') AND ($8=CAST(0 AS BIGINT) OR (auto_deploy=1 AND NOT EXISTS (SELECT 1 FROM ephor_deployment WHERE service_id=$2 AND run_number >= $8))) ON CONFLICT DO NOTHING RETURNING id",
      [
        jobId,
        row.id,
        action,
        await this.secrets.seal(jobId, config),
        now,
        options.sha ?? null,
        options.delivery ?? null,
        options.run ?? 0,
        JSON.stringify(domains),
        protocol,
        ["restore", "delete-backup"].includes(action) ? options.backupId : null,
        row.config,
        row.source,
        row.domains ?? "",
      ],
    );
    if (!inserted.length)
      throw new AuthError("DEPLOYMENT_ALREADY_RUNNING", 409);
    await new AuthStore(this.sql).audit(`service.${action}_requested`, row.id);
    return { id: jobId };
  }
  async cancel(id: unknown) {
    const rows = await this.sql.query(
      "UPDATE ephor_deployment SET status='cancelled',updated_at=$1 WHERE id=$2 AND status='queued' RETURNING service_id",
      [Date.now(), serviceId(id)],
    );
    if (!rows.length) throw new AuthError("DEPLOYMENT_NOT_QUEUED", 409);
    await new AuthStore(this.sql).audit(
      "service.deployment_cancelled",
      String(rows[0]?.service_id),
    );
  }
  async issueWorker(machineId: unknown) {
    const id = serviceId(machineId),
      token = randomToken();
    if (
      !(
        await this.sql.query(
          "SELECT id FROM ephor_machine WHERE id=$1 AND state='active'",
          [id],
        )
      ).length
    )
      throw new AuthError("MACHINE_NOT_FOUND", 404);
    await this.sql.query(
      "INSERT INTO ephor_service_worker (machine_id,enrollment_hash,enrollment_expires) VALUES ($1,$2,$3) ON CONFLICT(machine_id) DO UPDATE SET enrollment_hash=$2,enrollment_expires=$3",
      [id, await hash(token), Date.now() + 600000],
    );
    return token;
  }
  async enroll(token: string, credential: unknown) {
    if (typeof credential !== "string" || !/^[a-f0-9]{64}$/.test(credential))
      throw new AuthError("INVALID_WORKER_CREDENTIAL");
    const digest = await hash(credential);
    // Bootstrap grants belong to the pending machine, so cancellation and
    // regeneration invalidate both credentials without creating a worker row.
    // Never replace an existing worker (including one repaired by the owner).
    await this.sql.query(
      `INSERT INTO ephor_service_worker (machine_id,enrollment_hash,enrollment_expires)
       SELECT id,worker_enrollment_hash,enrollment_expires FROM ephor_machine
       WHERE worker_enrollment_hash=$1 AND enrollment_expires>$2 AND state='active'
       ON CONFLICT(machine_id) DO NOTHING`,
      [await hash(token), Date.now()],
    );
    const rows = await this.sql.query<{ machine_id: string }>(
      "UPDATE ephor_service_worker SET credential_hash=$1 WHERE enrollment_hash=$2 AND enrollment_expires > $3 AND EXISTS (SELECT 1 FROM ephor_machine WHERE id=machine_id AND state='active') AND (credential_hash IS NULL OR credential_hash=$1) RETURNING machine_id",
      [digest, await hash(token), Date.now()],
    );
    if (!rows[0]) throw new AuthError("INVALID_WORKER_ENROLLMENT", 401);
    return { id: rows[0].machine_id };
  }
  async identity(token: string) {
    const [row] = await this.sql.query<{ machine_id: string }>(
      "SELECT machine_id FROM ephor_service_worker WHERE credential_hash=$1 AND EXISTS (SELECT 1 FROM ephor_machine WHERE id=machine_id AND state='active')",
      [await hash(token)],
    );
    if (!row) throw new AuthError("INVALID_WORKER_CREDENTIAL", 401);
    return row.machine_id;
  }
  async heartbeat(machineId: string, version = 1) {
    await this.sql.query(
      "UPDATE ephor_service_worker SET last_seen=$1,version=$3 WHERE machine_id=$2",
      [Date.now(), machineId, String(version)],
    );
  }
  async next(machineId: string, version: unknown) {
    if (
      version !== 1 &&
      version !== 2 &&
      version !== 3 &&
      version !== 4 &&
      version !== 5 &&
      version !== 6
    )
      throw new AuthError("INCOMPATIBLE_SERVICE_WORKER", 409);
    await this.sql.query(
      "UPDATE ephor_service_worker SET last_seen=$1,version=$3 WHERE machine_id=$2",
      [Date.now(), machineId, String(version)],
    );
    // Never expire a claimed deployment and race a worker that is still applying it.
    await this.sql.query(
      "UPDATE ephor_deployment SET status='expired',updated_at=$1 WHERE machine_id=$2 AND status='queued' AND created_at < $3",
      [Date.now(), machineId, Date.now() - 3600000],
    );
    await machineClaim(this.sql, machineId, async () =>
      this.sql.query(
        "UPDATE ephor_deployment SET status='running',updated_at=$1 WHERE id=(SELECT id FROM ephor_deployment WHERE machine_id=$2 AND status='queued' AND protocol <= $3 AND ($3>=2 OR domains IS NULL) ORDER BY created_at,id LIMIT 1) AND status='queued' AND NOT EXISTS (SELECT 1 FROM ephor_deployment WHERE machine_id=$2 AND status='running') AND NOT EXISTS (SELECT 1 FROM ephor_backup_job WHERE machine_id=$2 AND status='running') AND NOT EXISTS (SELECT 1 FROM ephor_update WHERE machine_id=$2 AND ((status IN ('queued','downloading') AND expires_at>$1) OR status='installing' OR (status='expired' AND install_started=1))) AND NOT EXISTS (SELECT 1 FROM ephor_machine WHERE id=$2 AND maintenance_until>$1) RETURNING id",
        [Date.now(), machineId, version],
      ),
    );
    const [job] = await this.sql.query<DeploymentRow>(
      "SELECT * FROM ephor_deployment WHERE machine_id=$1 AND status='running' ORDER BY created_at,id LIMIT 1",
      [machineId],
    );
    if (!job || job.protocol > Number(version)) return null;
    const row = await this.get(job.service_id);
    return {
      id: job.id,
      serviceId: row.id,
      domain: job.domains ? JSON.parse(job.domains).primary : row.domain,
      ...(Number(version) >= 2
        ? { domains: job.domains ? JSON.parse(job.domains) : readDomains(row) }
        : {}),
      action: job.action,
      ...(job.backup_id ? { backupId: job.backup_id } : {}),
      spec: await this.secrets.open<ServiceSpec>(job.id, job.spec),
    };
  }
  async report(machineId: string, body: unknown) {
    const b = object(body),
      id = serviceId(b.id);
    if (!["succeeded", "failed"].includes(String(b.status)))
      throw new AuthError("INVALID_DEPLOYMENT_REPORT");
    const [job] = await this.sql.query<DeploymentRow>(
      "SELECT * FROM ephor_deployment WHERE id=$1 AND machine_id=$2",
      [id, machineId],
    );
    if (!job || !["running", String(b.status)].includes(job.status))
      throw new AuthError("DEPLOYMENT_NOT_ACTIVE", 409);
    let digest: string | null = null;
    if (
      b.status === "succeeded" &&
      !["stop", "backup", "delete-backup"].includes(job.action)
    ) {
      if (typeof b.digest !== "string" || !b.digest.includes("@sha256:"))
        throw new AuthError("INVALID_IMAGE");
      digest = spec({ image: b.digest }).image;
    }
    const errors = [
      "IMAGE_PULL_FAILED",
      "INSUFFICIENT_CAPACITY",
      "HEALTH_CHECK_FAILED",
      "ROUTE_SWITCH_FAILED",
      "WORKER_INTERRUPTED",
      "DEPLOYMENT_FAILED",
      "CATALOG_RECOVERY_REQUIRED",
      "BACKUP_LIMIT",
      "BACKUP_FAILED",
      "CATALOG_WORKER_REQUIRED",
      "DOCKER_VERSION_REQUIRED",
    ];
    const error =
      b.status === "failed"
        ? errors.includes(String(b.error))
          ? String(b.error)
          : "DEPLOYMENT_FAILED"
        : null;
    // Update service before terminal job receipt, so a lost response is safely retryable.
    if (
      b.status === "succeeded" &&
      !["backup", "delete-backup"].includes(job.action)
    )
      await this.sql.query(
        "UPDATE ephor_service SET current_deployment=$1 WHERE id=$2 AND EXISTS (SELECT 1 FROM ephor_deployment WHERE id=$1 AND status='running')",
        [id, job.service_id],
      );
    const changed = await this.sql.query(
      "UPDATE ephor_deployment SET status=$1,digest=$2,error=$3,updated_at=$4 WHERE id=$5 AND status='running' RETURNING id",
      [b.status, digest, error, Date.now(), id],
    );
    if (changed.length)
      await new AuthStore(this.sql).audit(
        `service.deployment_${b.status}`,
        job.service_id,
      );
  }
  async runtime(machineId: string, body: unknown) {
    const b = object(body),
      id = serviceId(b.id);
    if (
      !["running", "unhealthy", "stopped", "missing"].includes(
        String(b.status),
      ) ||
      typeof b.logs !== "string" ||
      b.logs.length > 12000 ||
      typeof b.container !== "string" ||
      !/^[a-z0-9-]{0,100}$/.test(b.container)
    )
      throw new AuthError("INVALID_RUNTIME");
    const row = await this.get(id);
    if (row.machine_id !== machineId)
      throw new AuthError("SERVICE_NOT_FOUND", 404);
    const metrics = readMetrics(b.metrics);
    const catalog = readCatalogRuntime(b.catalog);
    const now = Date.now();
    // Redact literal configured secrets. Never render logs as HTML; logs remain owner-only.
    const config = await this.secrets.open<ServiceSpec>(row.id, row.config);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip untrusted terminal control characters
    let logs = b.logs.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    const secrets = [
      ...Object.values(config.environment),
      config.registry?.password ?? "",
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) logs = logs.replaceAll(secret, "[redacted]");
    if (catalog) {
      if (!isStateful(config)) throw new AuthError("INVALID_CATALOG_REPORT");
      const recipe = config.catalog
        ? template(config.catalog.template, config.catalog.version)
        : { components: [{ id: "web", image: "" }] };
      const names = new Set<string>();
      for (const component of catalog.components) {
        if (
          names.has(component.name) ||
          !recipe.components.some(
            (c) =>
              c.id === component.name &&
              (!config.catalog || c.image === component.image),
          )
        )
          throw new AuthError("INVALID_CATALOG_REPORT");
        names.add(component.name);
        if (component.logs !== undefined) {
          component.logs = component.logs.replace(
            // biome-ignore lint/suspicious/noControlCharactersInRegex: strip untrusted terminal controls
            /[\x00-\x08\x0b-\x1f\x7f]/g,
            "",
          );
          for (const secret of secrets)
            component.logs = component.logs.replaceAll(secret, "[redacted]");
        }
      }
    }
    await this.sql.query(
      "UPDATE ephor_service SET runtime=$1,runtime_at=$2 WHERE id=$3 AND machine_id=$4",
      [
        JSON.stringify({
          status: b.status,
          logs,
          container: b.container,
          metrics,
          ...(catalog ? { catalog } : {}),
        }),
        now,
        id,
        machineId,
      ],
    );
    if (metrics) await recordMetrics(this.sql, id, metrics, now);
    for (const component of catalog?.components ?? []) {
      if (component.metrics)
        await recordMetrics(
          this.sql,
          id,
          component.metrics,
          now,
          component.name,
        );
    }
  }
  async resources(id: unknown, body: unknown) {
    const row = await this.get(id);
    const config = await this.secrets.open<ServiceSpec>(row.id, row.config);
    if (
      !config.catalog ||
      !["postgres", "redis", "qdrant"].includes(config.catalog.template)
    )
      throw new AuthError("INVALID_DATABASE_RESOURCES");
    config.catalog.resources = object(body) as unknown as NonNullable<
      typeof config.catalog.resources
    >;
    const validated = spec(config);
    await this.sql.query("UPDATE ephor_service SET config=$1 WHERE id=$2", [
      await this.secrets.seal(row.id, validated),
      row.id,
    ]);
    await new AuthStore(this.sql).audit("service.resources_configured", row.id);
  }
  async catalogAccess(id: unknown, protection?: boolean) {
    const row = await this.get(id),
      config = await this.secrets.open<ServiceSpec>(row.id, row.config);
    if (!config.catalog) throw new AuthError("NOT_A_CATALOG_APP");
    if (protection !== undefined) {
      if (!template(config.catalog.template, config.catalog.version).web)
        throw new AuthError("NOT_A_WEB_APP");
      config.catalog.protected = protection;
      await this.sql.query("UPDATE ephor_service SET config=$1 WHERE id=$2", [
        await this.secrets.seal(row.id, config),
        row.id,
      ]);
    }
    await new AuthStore(this.sql).audit(
      protection !== undefined
        ? "service.setup_protection_changed"
        : "service.credentials_revealed",
      row.id,
    );
    return protection !== undefined
      ? { ok: true }
      : { credentials: config.environment };
  }
  async workers() {
    return this.sql.query<{ machine_id: string; last_seen: number }>(
      "SELECT machine_id,last_seen,version FROM ephor_service_worker",
    );
  }
}
