import { AuthError, hash, randomToken, type Sql } from "../auth/store";
import { machineClaim } from "../machines/maintenance-lock";
import { TOKEN } from "../machines/store";
import { Security } from "../security/store";
import { id, text } from "../security/validation";
import { object } from "../services/spec";
import {
  type ProtectionJob,
  type ProtectionMachine,
  type ProtectionSnapshot,
  protectionPlan,
} from "./types";
import { action, parameters, snapshot } from "./validation";

const MINUTE = 60000;
function job(r: Record<string, unknown>): ProtectionJob {
  return {
    id: String(r.id),
    machineId: String(r.machine_id),
    action: r.action as ProtectionJob["action"],
    parameters: JSON.parse(String(r.parameters)),
    revision: String(r.revision),
    status: String(r.status),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    result: r.result as string | null,
  };
}
export class Protections {
  constructor(readonly sql: Sql) {}
  async audit(
    machine: string,
    actor: string,
    action: string,
    outcome: string,
    detail: string,
    eventId: string = crypto.randomUUID(),
  ) {
    await new Security(this.sql).event(
      eventId,
      machine,
      null,
      null,
      "protection",
      actor,
      action.startsWith("updates.") ? action : `crowdsec.${action}`,
      outcome,
      detail,
      Date.now(),
    );
  }
  async expire(machine: string) {
    const rows = await this.sql.query(
      "UPDATE ephor_protection_job SET status='expired',finished_at=$2,result='Authorization expired; inspect machine status before retrying.' WHERE machine_id=$1 AND status IN ('draft','queued','running') AND expires_at<=$2 RETURNING id,actor,action",
      [machine, Date.now()],
    );
    for (const r of rows)
      await this.audit(
        machine,
        String(r.actor),
        String(r.action),
        "expired",
        "Job authorization expired.",
      );
  }
  async issue(
    machineValue: unknown,
    actor: string,
    preserveCredential = false,
  ) {
    const machine = id(machineValue),
      token = randomToken(),
      expiresAt = Date.now() + 10 * MINUTE;
    const rows = await this.sql.query(
      `INSERT INTO ephor_protection_agent(machine_id,enrollment_hash,enrollment_expires) SELECT id,$2,$3 FROM ephor_machine WHERE id=$1 AND state='active' ON CONFLICT(machine_id) DO UPDATE SET enrollment_hash=excluded.enrollment_hash,enrollment_expires=excluded.enrollment_expires,enrollment_claim_hash=NULL${preserveCredential ? "" : ",credential_hash=NULL,enabled=0"} RETURNING machine_id`,
      [machine, await hash(token), expiresAt],
    );
    if (!rows.length) throw new AuthError("ACTIVE_MACHINE_REQUIRED", 409);
    if (!preserveCredential) await this.cancel(machine);
    await this.audit(
      machine,
      actor,
      "enrollment",
      "issued",
      preserveCredential
        ? "Maintenance enrollment issued; existing management remains authorized until enrollment."
        : "Separate protection management grant issued; previous credential revoked.",
    );
    return { token, expiresAt };
  }
  async enroll(token: string, credential: unknown) {
    if (
      !TOKEN.test(token) ||
      typeof credential !== "string" ||
      !TOKEN.test(credential) ||
      credential === token
    )
      throw new AuthError("INVALID_PROTECTION_ENROLLMENT", 401);
    const digest = await hash(credential);
    const rows = await this.sql.query(
      `UPDATE ephor_protection_agent SET credential_hash=$1,enrollment_claim_hash=$1,enabled=1 WHERE enrollment_hash=$2 AND enrollment_expires>$3 AND (enrollment_claim_hash IS NULL OR enrollment_claim_hash=$1) AND EXISTS(SELECT 1 FROM ephor_machine WHERE id=machine_id AND state='active') RETURNING machine_id`,
      [digest, await hash(token), Date.now()],
    );
    if (!rows.length) throw new AuthError("INVALID_PROTECTION_ENROLLMENT", 401);
    return { id: String(rows[0]?.machine_id) };
  }
  async identity(credential: string) {
    const digest = await hash(credential);
    const [r] = await this.sql.query(
      `SELECT a.machine_id FROM ephor_protection_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.credential_hash=$1 AND a.enabled=1 AND m.state='active'`,
      [digest],
    );
    if (!r) throw new AuthError("INVALID_PROTECTION_CREDENTIAL", 401);
    return { machineId: String(r.machine_id), digest };
  }
  async cancel(machine: string) {
    await this.sql.query(
      "UPDATE ephor_protection_job SET status='cancelled',finished_at=$2,result='Management authorization revoked.' WHERE machine_id=$1 AND status IN ('draft','queued','running')",
      [machine, Date.now()],
    );
  }
  async revoke(machineValue: unknown, actor: string) {
    const machine = id(machineValue);
    await this.sql.query(
      "UPDATE ephor_protection_agent SET enabled=0,credential_hash=NULL,enrollment_hash=NULL WHERE machine_id=$1",
      [machine],
    );
    await this.cancel(machine);
    await this.audit(
      machine,
      actor,
      "revoke",
      "completed",
      "Management revoked. Locally leased SSH blocks expire within 150 seconds; detection remains installed.",
    );
  }
  async list(machineValue?: string) {
    const machine = machineValue ? id(machineValue) : null;
    const rows = await this.sql.query(
      `SELECT m.id,m.name,a.enabled,a.last_seen,a.snapshot FROM ephor_machine m LEFT JOIN ephor_protection_agent a ON a.machine_id=m.id WHERE m.state='active' ${machine ? "AND m.id=$1" : ""} ORDER BY m.name`,
      machine ? [machine] : [],
    );
    const history = await this.sql.query(
      `SELECT * FROM (SELECT j.*,ROW_NUMBER() OVER (PARTITION BY j.machine_id ORDER BY j.created_at DESC,j.id DESC) AS rank FROM ephor_protection_job j JOIN ephor_machine m ON m.id=j.machine_id WHERE m.state='active' ${machine ? "AND j.machine_id=$1" : ""}) recent WHERE rank<=12`,
      machine ? [machine] : [],
    );
    const result: ProtectionMachine[] = [];
    for (const r of rows) {
      const machineId = String(r.id);
      const jobs = history
        .filter((j) => j.machine_id === machineId)
        .map((j) =>
          Number(j.expires_at) <= Date.now() &&
          ["draft", "queued", "running"].includes(String(j.status))
            ? {
                ...j,
                status: "expired",
                result:
                  "Authorization expired; inspect machine status before retrying.",
              }
            : j,
        );
      result.push({
        id: machineId,
        name: String(r.name),
        enabled: r.enabled === 1,
        lastSeen: r.last_seen ? Number(r.last_seen) : null,
        snapshot: r.snapshot ? JSON.parse(String(r.snapshot)) : null,
        jobs: jobs.map(job),
      });
    }
    return result;
  }
  async plan(value: unknown, actor: string) {
    const b = object(value),
      machine = id(b.machineId),
      a = action(b.action),
      params = parameters(a, b.parameters ?? {});
    await this.expire(machine);
    const [r] = await this.sql.query(
      `SELECT a.* FROM ephor_protection_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.machine_id=$1 AND a.enabled=1 AND a.credential_hash IS NOT NULL AND m.state='active'`,
      [machine],
    );
    if (!r || Number(r.last_seen) < Date.now() - 90_000 || !r.snapshot)
      throw new AuthError("PROTECTION_HELPER_REQUIRED", 409);
    const state: ProtectionSnapshot = JSON.parse(String(r.snapshot));
    if (a.startsWith("updates.")) {
      const updates = state.updates;
      if (
        !updates ||
        ((a === "updates.install" || a === "updates.configure") &&
          updates.scheduleVersion !== 2)
      )
        throw new AuthError("PROTECTION_HELPER_UPGRADE_REQUIRED", 409);
      if (!updates.supported || updates.busy)
        throw new AuthError("PROTECTION_UNSUPPORTED", 409);
      if (a === "updates.install" ? updates.managed : !updates.managed)
        throw new AuthError("PROTECTION_STATE_CHANGED", 409);
      if (updates.managed && !updates.healthy)
        throw new AuthError("UPDATE_POLICY_CONFLICT", 409);
    } else {
      if (state.ownership === "external" || !state.supported)
        throw new AuthError("PROTECTION_UNSUPPORTED", 409);
      if (
        a === "install"
          ? state.ownership !== "absent"
          : state.ownership !== "managed"
      )
        throw new AuthError("PROTECTION_STATE_CHANGED", 409);
      if (
        a === "enable" &&
        (!state.engineRunning ||
          !state.acquisitionReady ||
          !state.sshPorts.length ||
          state.blocking !== "off")
      )
        throw new AuthError("PROTECTION_NOT_READY", 409);
      if (
        a === "confirm" &&
        (state.blocking !== "pending" ||
          !state.confirmBefore ||
          state.confirmBefore <= Date.now())
      )
        throw new AuthError("PROTECTION_TRIAL_EXPIRED", 409);
    }
    const jobId = crypto.randomUUID(),
      now = Date.now();
    // Persist the exact reviewed payload. Approval never accepts replacement parameters.
    await this.sql.query(
      `INSERT INTO ephor_protection_job(id,machine_id,credential_hash,action,parameters,revision,actor,status,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9)`,
      [
        jobId,
        machine,
        r.credential_hash,
        a,
        JSON.stringify(params),
        state.revision,
        actor,
        now,
        now + 5 * MINUTE,
      ],
    );
    return {
      id: jobId,
      action: a,
      parameters: params,
      steps: protectionPlan(a),
      expiresAt: now + 5 * MINUTE,
    };
  }
  async approve(value: unknown, actor: string) {
    const key = id(value);
    const [draft] = await this.sql.query(
      "SELECT * FROM ephor_protection_job WHERE id=$1",
      [key],
    );
    if (!draft) throw new AuthError("PROTECTION_PLAN_EXPIRED", 409);
    // Older window-based drafts must be reviewed again with the new schedule.
    if (["updates.install", "updates.configure"].includes(String(draft.action)))
      parameters(action(draft.action), JSON.parse(String(draft.parameters)));
    await this.expire(String(draft.machine_id));
    if (
      (
        await this.sql.query(
          "SELECT id FROM ephor_protection_job WHERE machine_id=$1 AND status IN ('queued','running')",
          [draft.machine_id],
        )
      ).length
    )
      throw new AuthError("PROTECTION_JOB_ACTIVE", 409);
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql.query(
        `UPDATE ephor_protection_job SET status='queued',actor=$2,expires_at=$3 WHERE id=$1 AND status='draft' AND expires_at>$4 AND EXISTS(SELECT 1 FROM ephor_protection_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.machine_id=ephor_protection_job.machine_id AND a.credential_hash=ephor_protection_job.credential_hash AND a.revision=ephor_protection_job.revision AND a.enabled=1 AND a.last_seen>$5 AND m.state='active') RETURNING *`,
        [key, actor, Date.now() + 15 * MINUTE, Date.now(), Date.now() - 90_000],
      );
    } catch {
      throw new AuthError("PROTECTION_JOB_ACTIVE", 409);
    }
    const row = rows[0];
    if (!row) throw new AuthError("PROTECTION_STATE_CHANGED", 409);
    await this.audit(
      String(draft.machine_id),
      actor,
      String(draft.action),
      "approved",
      JSON.stringify({
        job: key,
        parameters: JSON.parse(String(draft.parameters)),
        before: draft.revision,
        steps: protectionPlan(action(draft.action)),
      }),
    );
    return job(row);
  }
  async next(machine: string, digest: string, value: unknown) {
    const state = snapshot(value),
      now = Date.now();
    const [previous] = await this.sql.query(
      "SELECT snapshot FROM ephor_protection_agent WHERE machine_id=$1 AND credential_hash=$2 AND enabled=1",
      [machine, digest],
    );
    const before: ProtectionSnapshot | null = previous?.snapshot
      ? JSON.parse(String(previous.snapshot))
      : null;
    const rows = await this.sql.query(
      `UPDATE ephor_protection_agent SET last_seen=$3,snapshot=$4,revision=$5 WHERE machine_id=$1 AND credential_hash=$2 AND enabled=1 AND EXISTS(SELECT 1 FROM ephor_machine WHERE id=$1 AND state='active') RETURNING machine_id`,
      [machine, digest, now, JSON.stringify(state), state.revision],
    );
    if (!rows.length) throw new AuthError("INVALID_PROTECTION_CREDENTIAL", 401);
    const previousBans = new Map(
      (before?.bans ?? []).map((b) => [b.ip, b.reason]),
    );
    const currentBans = new Map(state.bans.map((b) => [b.ip, b.reason]));
    const added = state.bans.filter((b) => previousBans.get(b.ip) !== b.reason);
    const removed = (before?.bans ?? []).filter((b) => !currentBans.has(b.ip));
    if (
      added.length ||
      removed.length ||
      (before &&
        (before.blocking !== state.blocking ||
          before.engineRunning !== state.engineRunning ||
          before.acquisitionReady !== state.acquisitionReady))
    ) {
      await this.audit(
        machine,
        "CrowdSec management helper",
        "observation",
        state.blocking,
        JSON.stringify({
          detectionRunning: state.engineRunning,
          acquisitionReady: state.acquisitionReady,
          blocking: state.blocking,
          added,
          removed: removed.map((b) => ({ ip: b.ip, reason: b.reason })),
          detail: state.detail,
        }),
      );
    }
    if (
      state.updates &&
      JSON.stringify(before?.updates) !== JSON.stringify(state.updates)
    )
      await this.audit(
        machine,
        "Protection management helper",
        "updates.observation",
        "recorded",
        JSON.stringify(state.updates),
      );
    await this.expire(machine);
    const [r] =
      (await machineClaim(this.sql, machine, async () =>
        this.sql.query(
          `UPDATE ephor_protection_job SET status='running',started_at=COALESCE(started_at,$3) WHERE id=(SELECT id FROM ephor_protection_job WHERE machine_id=$1 AND credential_hash=$2 AND status IN ('queued','running') AND expires_at>$3 ORDER BY created_at,id LIMIT 1) AND status IN ('queued','running') AND (status='running' OR NOT EXISTS (SELECT 1 FROM ephor_update WHERE machine_id=$1 AND ((status IN ('queued','downloading') AND expires_at>$3) OR status='installing' OR (status='expired' AND install_started=1))) AND NOT EXISTS (SELECT 1 FROM ephor_machine WHERE id=$1 AND maintenance_until>$3)) AND EXISTS(SELECT 1 FROM ephor_protection_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.machine_id=$1 AND a.credential_hash=$2 AND a.enabled=1 AND m.state='active') RETURNING *`,
          [machine, digest, now],
        ),
      )) ?? [];
    return { job: r ? job(r) : null };
  }
  async report(machine: string, digest: string, value: unknown) {
    const b = object(value),
      key = id(b.id);
    if (!["completed", "failed"].includes(String(b.status)))
      throw new AuthError("INVALID_PROTECTION_REPORT");
    const result = text(b.result, 600);
    const rows = await this.sql.query(
      `UPDATE ephor_protection_job SET status=$4,result=$5,finished_at=$6 WHERE id=$1 AND machine_id=$2 AND credential_hash=$3 AND status='running' AND expires_at>$6 AND EXISTS(SELECT 1 FROM ephor_protection_agent a JOIN ephor_machine m ON m.id=a.machine_id WHERE a.machine_id=$2 AND a.credential_hash=$3 AND a.enabled=1 AND m.state='active') RETURNING action,actor`,
      [key, machine, digest, b.status, result, Date.now()],
    );
    if (!rows.length) {
      const [r] = await this.sql.query(
        "SELECT status,result FROM ephor_protection_job WHERE id=$1 AND machine_id=$2 AND credential_hash=$3",
        [key, machine, digest],
      );
      if (r && r.status === b.status && r.result === result) return;
      throw new AuthError("PROTECTION_JOB_EXPIRED", 409);
    }
    await this.audit(
      machine,
      String(rows[0]?.actor),
      String(rows[0]?.action),
      String(b.status),
      JSON.stringify({ job: key, result }),
      key,
    );
  }
}
