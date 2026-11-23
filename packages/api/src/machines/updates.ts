import { AuthError, AuthStore, type Sql } from "../auth/store";
import { machineClaim } from "./maintenance-lock";
import { HEX_KEY, newer, type Releases, versionParts } from "./releases";

export const COMPONENT_IDS = [
  "monitoring",
  "deployments",
  "security",
  "protections",
  "updater",
] as const;
export interface MachineComponent {
  id: (typeof COMPONENT_IDS)[number];
  installed: boolean;
  active: boolean;
  version: string | null;
  buildId: string | null;
}
export function componentInventory(value: unknown): MachineComponent[] {
  if (!Array.isArray(value) || value.length !== 5)
    throw new AuthError("INVALID_UPDATER_INVENTORY");
  const ids = new Set<string>();
  const result = value.map((c) => {
    if (
      !c ||
      !COMPONENT_IDS.includes(c.id) ||
      ids.has(c.id) ||
      typeof c.installed !== "boolean" ||
      typeof c.active !== "boolean" ||
      (c.version !== null &&
        (typeof c.version !== "string" || c.version.length > 30)) ||
      (c.buildId !== null &&
        (typeof c.buildId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(c.buildId)))
    )
      throw new AuthError("INVALID_UPDATER_INVENTORY");
    if (c.version !== null) versionParts(c.version);
    ids.add(c.id);
    return {
      id: c.id,
      installed: c.installed,
      active: c.active,
      version: c.version,
      buildId: c.buildId,
    } as MachineComponent;
  });
  if (
    !result.some((c) => c.id === "monitoring" && c.installed) ||
    !result.some((c) => c.id === "updater" && c.installed)
  )
    throw new AuthError("INVALID_UPDATER_INVENTORY");
  return result;
}
// Fixed table names and bound machine IDs; shared by every runtime adapter.
export async function maintenanceBusy(sql: Sql, machine: string) {
  const rows = await sql.query(
    `SELECT id FROM ephor_deployment WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT id FROM ephor_build WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT id FROM ephor_backup_job WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT id FROM ephor_security_scan WHERE machine_id=$1 AND status='running'
    UNION ALL SELECT id FROM ephor_protection_job WHERE machine_id=$1 AND status='running' LIMIT 1`,
    [machine],
  );
  return rows.length > 0;
}

export interface UpdateJob {
  id: string;
  machine_id: string;
  version: string;
  build_id: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  install_started: number;
}
export class Updates {
  constructor(
    private sql: Sql,
    private releases: Releases,
  ) {}
  async queue(machineId: unknown, wholeMachine = false, automatic = false) {
    if (typeof machineId !== "string" || machineId.length > 64)
      throw new AuthError("INVALID_ID");
    const result = await machineClaim(this.sql, machineId, () =>
      this.queueLocked(machineId, wholeMachine, automatic),
    );
    if (!result) throw new AuthError("MACHINE_BUSY", 409);
    return result;
  }
  private async queueLocked(
    machineId: unknown,
    wholeMachine: boolean,
    automatic: boolean,
  ) {
    if (typeof machineId !== "string" || machineId.length > 64)
      throw new AuthError("INVALID_ID");
    const latest = await this.releases.read();
    if (!latest.release || !latest.envelope)
      throw new AuthError("NO_VERIFIED_RELEASE", 409);
    const rows = await this.sql.query<{
      telemetry: string;
      updater_key: string;
      updater_seen: number;
      updater_protocol: number;
      updater_components: string | null;
      update_policy: string;
      pinned_version: string | null;
    }>(
      "SELECT telemetry, updater_key, updater_seen, updater_protocol, updater_components, update_policy, pinned_version FROM ephor_machine WHERE id = $1 AND state = 'active'",
      [machineId],
    );
    const machine = rows[0];
    if (
      !machine ||
      machine.updater_key !== this.releases.publicKey ||
      Number(machine.updater_seen) < Date.now() - 180000
    )
      throw new AuthError("UPDATER_BOOTSTRAP_REQUIRED", 409);
    await this.expire();
    const [recovery] = await this.sql.query(
      "SELECT id FROM ephor_update WHERE machine_id=$1 AND status='expired' AND install_started=1",
      [machineId],
    );
    if (recovery) throw new AuthError("UPDATE_RECOVERY_REQUIRED", 409);
    const current = JSON.parse(machine.telemetry || "{}");
    const release = latest.release;
    const protocol = release.updaterProtocol;
    if (automatic) {
      const [attempt] = await this.sql.query(
        "SELECT id FROM ephor_update WHERE machine_id=$1 AND build_id=$2",
        [machineId, release.buildId],
      );
      if (machine.update_policy !== "automatic" || attempt)
        throw new AuthError("NO_COMPATIBLE_UPDATE", 409);
    }
    if (
      machine.update_policy === "pinned" &&
      release.version !== machine.pinned_version
    )
      throw new AuthError("VERSION_PINNED", 409);
    if (protocol >= 2 && !wholeMachine)
      throw new AuthError("MACHINE_UPDATE_CONFIRMATION_REQUIRED", 409);
    if (wholeMachine && protocol < 2)
      throw new AuthError("MACHINE_RELEASE_REQUIRED", 409);
    if (
      (protocol >= 2 || Number(machine.updater_protocol) === 3) &&
      Number(machine.updater_protocol) !== protocol
    )
      throw new AuthError("MAINTENANCE_SETUP_REQUIRED", 409);
    let needsUpdate = newer(
      latest.release.version,
      current.agentVersion || "0.0.0",
    );
    if (protocol >= 2) {
      const components = componentInventory(
        JSON.parse(machine.updater_components || "null"),
      ).filter((c) => c.installed);
      if (
        components.some((c) => !c.version || newer(c.version, release.version))
      )
        throw new AuthError("NO_COMPATIBLE_UPDATE", 409);
      needsUpdate = components.some(
        (c) => c.version !== release.version || c.buildId !== release.buildId,
      );
    }
    if (!latest.release.artifacts[current.arch as "x86_64"] || !needsUpdate)
      throw new AuthError("NO_COMPATIBLE_UPDATE", 409);
    const [setup] = await this.sql.query(
      "SELECT id FROM ephor_machine WHERE id=$1 AND maintenance_until>$2",
      [machineId, Date.now()],
    );
    if (setup) throw new AuthError("MACHINE_BUSY", 409);
    if (await maintenanceBusy(this.sql, machineId))
      throw new AuthError("MACHINE_BUSY", 409);
    const id = crypto.randomUUID();
    const now = Date.now();
    const inserted = await this.sql.query(
      `INSERT INTO ephor_update (id, machine_id, envelope, version, build_id, status, created_at, updated_at, expires_at)
      SELECT $1, id, $3, $4, $5, 'queued', $6, $6, $7 FROM ephor_machine WHERE id = $2 AND state = 'active' AND maintenance_until <= $6 ON CONFLICT DO NOTHING RETURNING id`,
      [
        id,
        machineId,
        JSON.stringify(latest.envelope),
        latest.release.version,
        latest.release.buildId,
        now,
        now + 15 * 60000,
      ],
    );
    if (!inserted.length) throw new AuthError("UPDATE_ALREADY_RUNNING", 409);
    await new AuthStore(this.sql).audit("machine.update_requested", machineId);
    return { id };
  }
  async expire() {
    await this.sql.query(
      "UPDATE ephor_update SET status = 'expired', error = 'No completion received before the deadline; inspect the VPS before retrying.', updated_at = $1 WHERE status IN ('queued','downloading','installing') AND expires_at <= $1",
      [Date.now()],
    );
  }
  async next(
    machineId: string,
    key: unknown,
    protocol: unknown = 1,
    components?: unknown,
  ) {
    if (typeof key !== "string" || !HEX_KEY.test(key))
      throw new AuthError("INVALID_UPDATER");
    if (protocol !== 1 && protocol !== 2 && protocol !== 3)
      throw new AuthError("INVALID_UPDATER");
    const inventory = protocol >= 2 ? componentInventory(components) : null;
    await this.sql.query(
      "UPDATE ephor_machine SET updater_key = $1, updater_seen = $2, updater_protocol = $4, updater_components = $5 WHERE id = $3 AND state = 'active'",
      [
        key,
        Date.now(),
        machineId,
        protocol,
        inventory ? JSON.stringify(inventory) : null,
      ],
    );
    if (protocol === 3) {
      const [machine] = await this.sql.query(
        "SELECT update_policy,pinned_version FROM ephor_machine WHERE id=$1 AND state='active'",
        [machineId],
      );
      if (machine?.update_policy === "automatic") {
        await this.releases.check();
        const latest = await this.releases.read();
        if (latest.release?.updaterProtocol === 3) {
          // Never loop on a failed/ambiguous release. A new build or explicit manual retry is required.
          try {
            await this.queue(machineId, true, true);
          } catch (e) {
            if (!(e instanceof AuthError) || e.status !== 409) throw e;
          }
        }
      }
    }
    await this.expire();
    const [job] = await this.sql.query<{
      id: string;
      envelope: string;
      expires_at: number;
    }>(
      "SELECT id, envelope, expires_at FROM ephor_update WHERE machine_id = $1 AND EXISTS (SELECT 1 FROM ephor_machine WHERE id = $1 AND state = 'active') AND status IN ('queued','downloading','installing') ORDER BY created_at DESC LIMIT 1",
      [machineId],
    );
    // Old updater binaries must never consume a whole-machine job.
    if (job) {
      const required = JSON.parse(
        JSON.parse(job.envelope).manifest,
      ).updaterProtocol;
      if (required > protocol || (protocol === 3 && required !== 3))
        return null;
    }
    return job
      ? {
          id: job.id,
          envelope: JSON.parse(job.envelope),
          expiresAt: Number(job.expires_at),
        }
      : null;
  }
  async report(
    machineId: string,
    body: { id?: unknown; status?: unknown; error?: unknown },
  ) {
    if (
      typeof body?.id !== "string" ||
      body.id.length > 64 ||
      ![
        "downloading",
        "installing",
        "succeeded",
        "rolled_back",
        "failed",
      ].includes(String(body.status))
    )
      throw new AuthError("INVALID_UPDATE_REPORT");
    const error = body.error == null ? null : String(body.error).slice(0, 200);
    const terminal = ["succeeded", "rolled_back", "failed"].includes(
      String(body.status),
    );
    // Never move backwards or reopen a terminal job. Late terminal receipts resolve an
    // expired request; keeping the same receipt idempotent survives lost responses.
    const allowed =
      body.status === "downloading"
        ? ["queued"]
        : body.status === "installing"
          ? ["downloading"]
          : body.status === "succeeded"
            ? ["installing", "expired"]
            : ["queued", "downloading", "installing", "expired"];
    const rows = await this.sql.query(
      `UPDATE ephor_update SET status = $1, error = $2, updated_at = $3, install_started = CASE WHEN $1='installing' THEN 1 ELSE install_started END WHERE id = $4 AND machine_id = $5 AND EXISTS (SELECT 1 FROM ephor_machine WHERE id = $5 AND state = 'active') AND status IN (${allowed.map((_, index) => `$${index + 6}`).join(",")}) RETURNING id`,
      [body.status, error, Date.now(), body.id, machineId, ...allowed],
    );
    if (rows.length && terminal)
      await new AuthStore(this.sql).audit(
        `machine.update_${body.status}`,
        machineId,
      );
    if (!rows.length) {
      const [existing] = await this.sql.query<{ status: string }>(
        "SELECT status FROM ephor_update WHERE id = $1 AND machine_id = $2 AND EXISTS (SELECT 1 FROM ephor_machine WHERE id = $2 AND state = 'active')",
        [body.id, machineId],
      );
      if (!existing || existing.status !== body.status)
        throw new AuthError("UPDATE_NOT_ACTIVE", 409);
    }
  }

  async list() {
    await this.expire();
    const rows = await this.sql.query<UpdateJob & Record<string, unknown>>(
      "SELECT id, machine_id, version, build_id, status, error, created_at, updated_at, install_started FROM ephor_update ORDER BY created_at DESC LIMIT 1000",
    );
    return rows.map((row) => ({
      ...row,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }));
  }
}
