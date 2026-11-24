import { AuthError, AuthStore, type Sql } from "../auth/store";
import { machineClaim } from "../machines/maintenance-lock";
import { ServiceConnections } from "./connections";
import { readDomains } from "./domains";
import type { GitHubApp } from "./github-app";
import {
  IMAGE,
  object,
  requiredProtocol,
  type ServiceSource,
  type ServiceSpec,
  serviceId,
} from "./spec";
import { type ServiceRow, Services } from "./store";

interface Build extends Record<string, unknown> {
  id: string;
  service_id: string;
  machine_id: string;
  source: string;
  config: string;
  domains: string;
  status: string;
  automatic: number;
  digest: string | null;
  created_at: number;
  updated_at: number;
  logs: string;
  error: string | null;
  phase: string;
}
interface BuildSource extends ServiceSource {
  sha: string;
  image: string;
  registry?: ServiceSpec["registry"];
  variables: Record<string, string>;
}
export interface BuildRegistry {
  prefix: string;
  push: { username: string; password: string };
  pull: { username: string; password: string };
}
function sameRepository(source: ServiceSource, row: ServiceRow) {
  const current = JSON.parse(row.source) as ServiceSource;
  return [
    "installationId",
    "repositoryId",
    "ownerId",
    "repository",
    "branch",
  ].every(
    (key) =>
      source[key as keyof ServiceSource] ===
      current[key as keyof ServiceSource],
  );
}
export class Builds {
  readonly services: Services;
  constructor(
    readonly sql: Sql,
    secret: string,
    readonly github: GitHubApp,
  ) {
    this.services = new Services(sql, secret);
  }
  async registry(value: unknown) {
    const b = object(value),
      prefix = String(b.prefix ?? "");
    if (
      !IMAGE.test(`${prefix}/app:latest`) ||
      prefix.length > 170 ||
      prefix.startsWith("ephor.local/") ||
      prefix.includes(":")
    )
      throw new AuthError("INVALID_BUILD_REGISTRY");
    const push = object(b.push),
      pull = object(b.pull);
    for (const r of [push, pull])
      if (
        typeof r.username !== "string" ||
        !r.username ||
        r.username.length > 200 ||
        typeof r.password !== "string" ||
        !r.password ||
        r.password.length > 4096
      )
        throw new AuthError("INVALID_BUILD_REGISTRY");
    await this.github.integrations.set("build-registry", {
      prefix,
      push,
      pull,
    });
    await new AuthStore(this.sql).audit("build.registry_configured");
  }
  async queue(
    id: unknown,
    automatic = false,
    delivery?: string,
    pushedSha?: string,
    approvedSha?: string,
    approvedConfig?: string,
  ) {
    const row = await this.services.get(id),
      source = JSON.parse(row.source) as ServiceSource;
    if (approvedConfig && approvedConfig !== row.config)
      throw new AuthError("MCP_STATE_CHANGED", 409);
    if (!source.installationId)
      throw new AuthError("GITHUB_RECONNECT_REQUIRED", 409);
    if (automatic && !row.auto_deploy) return null;
    if (delivery) {
      const [existing] = await this.sql.query<{ id: string }>(
        "SELECT id FROM ephor_build WHERE delivery=$1",
        [delivery],
      );
      if (existing) return existing;
    }
    const machine = source.buildMachineId || row.machine_id;
    const workers = await this.sql.query<{
      machine_id: string;
      version: string;
      arch: string;
    }>(
      "SELECT w.machine_id,w.version,m.telemetry AS arch FROM ephor_service_worker w JOIN ephor_machine m ON m.id=w.machine_id WHERE (w.machine_id=$1 OR w.machine_id=$2) AND m.state='active' AND w.credential_hash IS NOT NULL",
      [machine, row.machine_id],
    );
    if (
      !automatic &&
      (!workers.some(
        (w) => w.machine_id === machine && Number(w.version) >= 2,
      ) ||
        !workers.some(
          (w) => w.machine_id === row.machine_id && Number(w.version) >= 2,
        ))
    )
      throw new AuthError("BUILD_WORKER_REQUIRED", 409);
    if (
      workers.some(
        (w) => JSON.parse(w.arch || "{}").arch !== source.architecture,
      )
    )
      throw new AuthError("BUILD_ARCHITECTURE_MISMATCH", 409);
    let config = await this.services.secrets.open<ServiceSpec>(
      row.id,
      row.config,
    );
    config = await new ServiceConnections(
      this.sql,
      this.services.secrets,
    ).resolve(row, config);
    if (
      requiredProtocol(config) >= 5 &&
      !workers.some(
        (w) =>
          w.machine_id === row.machine_id &&
          Number(w.version) >= requiredProtocol(config),
      )
    )
      throw new AuthError(
        requiredProtocol(config) >= 6
          ? "STATEFUL_WORKER_REQUIRED"
          : "CONNECTION_WORKER_REQUIRED",
        409,
      );
    let registry: ServiceSpec["registry"] | undefined;
    const buildId = crypto.randomUUID();
    let image = `ephor.local/${row.id}:${buildId}`;
    if (machine !== row.machine_id) {
      const r =
        await this.github.integrations.get<BuildRegistry>("build-registry");
      if (!r) throw new AuthError("BUILD_REGISTRY_REQUIRED", 409);
      image = `${r.prefix}/${row.id}:${buildId}`;
      registry = { server: r.prefix.split("/")[0] ?? "", ...r.push };
      config.registry = { server: r.prefix.split("/")[0] ?? "", ...r.pull };
    } else config.registry = null;
    // Only verified webhook callers supply a commit. Recheck the selected branch
    // when claiming and promoting; acknowledge pushes without slow GitHub requests.
    const sha =
      automatic && pushedSha && /^[a-f0-9]{40}$/.test(pushedSha)
        ? pushedSha
        : await this.github.head(source);
    // MCP approvals bind a deployment to the reviewed commit.
    if (approvedSha && sha !== approvedSha)
      throw new AuthError("MCP_STATE_CHANGED", 409);
    const variables =
      (
        await this.github.integrations.get<{
          variables: Record<string, string>;
        }>(`build-env:${row.id}`)
      )?.variables ?? {};
    const buildSource: BuildSource = {
      ...source,
      sha,
      image,
      registry,
      variables,
    };
    // Snapshot both build instructions and runtime settings. Build workers never receive runtime secrets.
    const now = Date.now();
    const inserted = await this.sql.query(
      "INSERT INTO ephor_build (id,service_id,machine_id,source,config,domains,status,created_at,updated_at,delivery,automatic) SELECT $1,id,$3,$4,$5,$6,'queued',$7,$7,$8,$9 FROM ephor_service WHERE id=$2 AND config=$10 AND source=$11 AND COALESCE(domains,'')=$12 AND ($9=0 OR auto_deploy=1) ON CONFLICT DO NOTHING RETURNING id",
      [
        buildId,
        row.id,
        machine,
        await this.services.secrets.seal(
          `build-source:${buildId}`,
          buildSource,
        ),
        await this.services.secrets.seal(buildId, config),
        JSON.stringify(readDomains(row)),
        now,
        delivery ?? null,
        automatic ? 1 : 0,
        row.config,
        row.source,
        row.domains ?? "",
      ],
    );
    if (!inserted.length) {
      if (approvedSha) throw new AuthError("MCP_STATE_CHANGED", 409);
      return null;
    }
    // Webhooks can arrive out of order. Supersede only after comparing with
    // GitHub's current branch head at claim time, never by delivery time.
    await new AuthStore(this.sql).audit("service.build_queued", row.id);
    return { id: buildId };
  }
  async list(id?: string, summary = false) {
    return this.sql.query(
      `SELECT id,service_id,machine_id,status,created_at,updated_at,digest,error,${summary ? "'' AS logs" : "logs"},phase FROM ephor_build ${id ? "WHERE service_id=$1" : ""} ORDER BY created_at DESC LIMIT 200`,
      id ? [id] : [],
    );
  }
  async cancel(id: unknown) {
    const rows = await this.sql.query(
      "UPDATE ephor_build SET status='cancelled',updated_at=$1 WHERE id=$2 AND status IN ('queued','running','built') RETURNING id",
      [Date.now(), serviceId(id)],
    );
    if (!rows.length) throw new AuthError("BUILD_NOT_ACTIVE", 409);
    await new AuthStore(this.sql).audit("service.build_cancelled", String(id));
  }
  async next(machineId: string) {
    await this.sql.query(
      "UPDATE ephor_build SET status='failed',error='BUILD_TIMED_OUT',updated_at=$1 WHERE machine_id=$2 AND status='running' AND updated_at<$3",
      [Date.now(), machineId, Date.now() - 300000],
    );
    // Built receipts waiting for a deployment slot survive restarts and offline destination machines.
    const built = await this.sql.query<Build>(
      "SELECT * FROM ephor_build WHERE machine_id=$1 AND status='built' ORDER BY created_at LIMIT 10",
      [machineId],
    );
    for (const row of built) await this.promote(row);
    await machineClaim(this.sql, machineId, async () =>
      this.sql.query(
        "UPDATE ephor_build SET status='running',phase='fetching',updated_at=$1 WHERE id=(SELECT id FROM ephor_build WHERE machine_id=$2 AND status='queued' ORDER BY created_at,id LIMIT 1) AND status='queued' AND NOT EXISTS (SELECT 1 FROM ephor_build WHERE machine_id=$2 AND status='running') AND NOT EXISTS (SELECT 1 FROM ephor_update WHERE machine_id=$2 AND ((status IN ('queued','downloading') AND expires_at>$1) OR status='installing' OR (status='expired' AND install_started=1))) AND NOT EXISTS (SELECT 1 FROM ephor_machine WHERE id=$2 AND maintenance_until>$1) RETURNING id",
        [Date.now(), machineId],
      ),
    );
    const [build] = await this.sql.query<Build>(
      "SELECT * FROM ephor_build WHERE machine_id=$1 AND status='running' LIMIT 1",
      [machineId],
    );
    if (!build) return null;
    const source = await this.services.secrets.open<BuildSource>(
      `build-source:${build.id}`,
      build.source,
    );
    const row = await this.services.get(build.service_id);
    try {
      if (
        !sameRepository(source, row) ||
        (build.automatic &&
          (!row.auto_deploy || (await this.github.head(source)) !== source.sha))
      ) {
        await this.sql.query(
          "UPDATE ephor_build SET status='superseded',updated_at=$1 WHERE id=$2 AND status='running'",
          [Date.now(), build.id],
        );
        return null;
      }
      const token = await this.github.token(
        source.installationId ?? "",
        source.repositoryId,
      );
      const current = JSON.parse(row.source) as ServiceSource;
      if ((source.context ?? ".") === (current.context ?? ".")) {
        const technology = await this.github.technology(
          source,
          source.sha,
          token,
        );
        if (technology !== undefined && current.technology !== technology) {
          await this.sql.query(
            "UPDATE ephor_service SET source=$1 WHERE id=$2 AND source=$3 AND EXISTS (SELECT 1 FROM ephor_build WHERE id=$4 AND status='running')",
            [
              JSON.stringify({ ...current, technology }),
              row.id,
              row.source,
              build.id,
            ],
          );
        }
      }
      return { id: build.id, serviceId: build.service_id, ...source, token };
    } catch (e) {
      await this.sql.query(
        "UPDATE ephor_build SET status='failed',error='GITHUB_ACCESS_FAILED',updated_at=$1 WHERE id=$2 AND status='running'",
        [Date.now(), build.id],
      );
      throw e;
    }
  }
  validateEnvironment(value: unknown) {
    const variables = object(value);
    if (
      Object.keys(variables).length > 32 ||
      JSON.stringify(variables).length > 8000
    )
      throw new AuthError("INVALID_ENVIRONMENT");
    for (const [k, v] of Object.entries(variables))
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) ||
        typeof v !== "string" ||
        v.includes("\0") ||
        v.length > 4096
      )
        throw new AuthError("INVALID_ENVIRONMENT");
    return variables;
  }
  async setEnvironment(id: string, value: unknown) {
    const variables = this.validateEnvironment(value);
    await this.github.integrations.set(`build-env:${id}`, { variables });
  }
  async progress(machineId: string, body: unknown) {
    const b = object(body),
      id = serviceId(b.id);
    const [build] = await this.sql.query<Build>(
      "SELECT * FROM ephor_build WHERE id=$1 AND machine_id=$2 AND status='running'",
      [id, machineId],
    );
    if (!build) return { active: false };
    await this.services.heartbeat(machineId, 2);
    const phase = ["fetching", "planning", "building", "publishing"].includes(
      String(b.phase),
    )
      ? String(b.phase)
      : build.phase;
    let logs = typeof b.logs === "string" ? b.logs.slice(-16000) : build.logs;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: log text cannot control terminals
    logs = logs.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    const source = await this.services.secrets.open<BuildSource>(
      `build-source:${id}`,
      build.source,
    );
    for (const secret of [
      ...Object.values(source.variables ?? {}),
      source.registry?.password ?? "",
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      logs = logs.replaceAll(secret, "[redacted]");
    const changed = await this.sql.query(
      "UPDATE ephor_build SET phase=$1,logs=$2,updated_at=$3 WHERE id=$4 AND status='running' RETURNING id",
      [phase, logs, Date.now(), id],
    );
    return { active: changed.length > 0 };
  }
  async report(machineId: string, body: unknown) {
    const b = object(body),
      id = serviceId(b.id);
    const [build] = await this.sql.query<Build>(
      "SELECT * FROM ephor_build WHERE id=$1 AND machine_id=$2",
      [id, machineId],
    );
    if (!build) throw new AuthError("BUILD_NOT_FOUND", 404);
    if (
      ["deployed", "cancelled", "superseded", "failed"].includes(build.status)
    )
      return { ok: true };
    if (build.status !== "running" && build.status !== "built")
      throw new AuthError("BUILD_NOT_ACTIVE", 409);
    if (b.error) {
      const error = [
        "BUILD_FAILED",
        "FETCH_FAILED",
        "BUILD_INTERRUPTED",
        "INSUFFICIENT_CAPACITY",
        "BUILD_TIMED_OUT",
        "BUILD_TOOLS_REQUIRED",
      ].includes(String(b.error))
        ? String(b.error)
        : "BUILD_FAILED";
      await this.sql.query(
        "UPDATE ephor_build SET status='failed',error=$1,updated_at=$2 WHERE id=$3 AND status='running'",
        [error, Date.now(), id],
      );
      return { ok: true };
    }
    const source = await this.services.secrets.open<BuildSource>(
      `build-source:${id}`,
      build.source,
    );
    const prefix = source.image.slice(0, source.image.lastIndexOf(":"));
    if (
      typeof b.digest !== "string" ||
      !IMAGE.test(b.digest) ||
      !b.digest.startsWith(`${prefix}@sha256:`) ||
      !/^.*@sha256:[a-f0-9]{64}$/.test(b.digest)
    )
      throw new AuthError("INVALID_BUILD_IMAGE");
    await this.sql.query(
      "UPDATE ephor_build SET status='built',digest=$1,phase='ready',updated_at=$2 WHERE id=$3 AND status='running'",
      [b.digest, Date.now(), id],
    );
    const [updated] = await this.sql.query<Build>(
      "SELECT * FROM ephor_build WHERE id=$1",
      [id],
    );
    if (updated) await this.promote(updated);
    return { ok: true };
  }
  async promote(build: Build) {
    const row = await this.services.get(build.service_id),
      source = await this.services.secrets.open<BuildSource>(
        `build-source:${build.id}`,
        build.source,
      );
    if (build.status !== "built" || !build.digest) return;
    if (
      !sameRepository(source, row) ||
      !(await this.github.integrations.get("github")) ||
      !(
        await this.sql.query(
          "SELECT id FROM ephor_github_installation WHERE id=$1",
          [source.installationId ?? ""],
        )
      ).length ||
      (build.automatic &&
        (!row.auto_deploy || (await this.github.head(source)) !== source.sha))
    ) {
      await this.sql.query(
        "UPDATE ephor_build SET status='superseded',updated_at=$1 WHERE id=$2 AND status='built'",
        [Date.now(), build.id],
      );
      return;
    }
    const config = await this.services.secrets.open<ServiceSpec>(
      build.id,
      build.config,
    );
    config.image = build.digest;
    await this.sql.query(
      "INSERT INTO ephor_deployment (id,service_id,machine_id,action,spec,status,created_at,updated_at,source_ref,domains,protocol) SELECT $1,id,machine_id,'deploy',$3,'queued',$4,$4,$5,$6,$7 FROM ephor_service WHERE id=$2 AND EXISTS (SELECT 1 FROM ephor_build WHERE id=$1 AND status='built') AND EXISTS (SELECT 1 FROM ephor_machine WHERE id=machine_id AND state='active') ON CONFLICT DO NOTHING",
      [
        build.id,
        row.id,
        await this.services.secrets.seal(build.id, config),
        Date.now(),
        source.sha,
        build.domains,
        requiredProtocol(config),
      ],
    );
    await this.sql.query(
      "UPDATE ephor_build SET status='deployed',updated_at=$1 WHERE id=$2 AND status='built' AND EXISTS (SELECT 1 FROM ephor_deployment WHERE id=$2)",
      [Date.now(), build.id],
    );
  }
  async webhook(event: string, body: unknown, delivery: string) {
    const b = object(body);
    if (
      event === "installation" &&
      ["deleted", "suspend"].includes(String(b.action))
    ) {
      const installation = object(b.installation);
      await this.sql.query(
        "DELETE FROM ephor_github_installation WHERE id=$1",
        [String(installation.id)],
      );
      // Running builds stop at their next progress report. Already running apps remain available.
      const services = await this.sql.query<ServiceRow>(
        "SELECT * FROM ephor_service",
      );
      for (const row of services)
        if (JSON.parse(row.source).installationId === String(installation.id))
          await this.sql.query(
            "UPDATE ephor_build SET status='cancelled',updated_at=$1 WHERE service_id=$2 AND status IN ('queued','running','built')",
            [Date.now(), row.id],
          );
      return;
    }
    if (event !== "push" || b.deleted === true) return;
    const repository = object(b.repository),
      installation = object(b.installation);
    if (
      !/^[a-f0-9]{40}$/.test(String(b.after)) ||
      typeof b.ref !== "string" ||
      !b.ref.startsWith("refs/heads/")
    )
      return;
    const rows = await this.sql.query<ServiceRow>(
      "SELECT * FROM ephor_service WHERE auto_deploy=1",
    );
    for (const row of rows) {
      const source = JSON.parse(row.source) as ServiceSource;
      if (
        source.installationId === String(installation.id) &&
        source.repositoryId === String(repository.id) &&
        `refs/heads/${source.branch}` === b.ref
      )
        await this.queue(
          row.id,
          true,
          `push:${delivery}:${row.id}`,
          String(b.after),
        );
    }
  }
}
