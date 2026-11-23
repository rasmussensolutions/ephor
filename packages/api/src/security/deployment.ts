import type { AuthEnvironment } from "../auth/config";
import { AuthError } from "../auth/store";
import { object } from "../services/spec";
import { Security } from "./store";
import type { SecurityDeployment } from "./types";
import { id, text } from "./validation";
export async function deployment(
  env: AuthEnvironment,
): Promise<SecurityDeployment> {
  const [row] = await env.sql.query(
    "SELECT * FROM ephor_security_deployment WHERE id=1",
  );
  return {
    runtime: env.deployment?.runtime ?? "unknown",
    origin: env.origin,
    database:
      env.deployment?.runtime === "cloudflare-worker"
        ? "D1"
        : env.deployment
          ? "PostgreSQL"
          : "unknown",
    frontendDetected: env.deployment?.frontend ?? "unknown",
    configured: {
      provider: String(row?.provider ?? ""),
      ingress: (row?.ingress ??
        "unknown") as SecurityDeployment["configured"]["ingress"],
      frontend: (row?.frontend ??
        "unknown") as SecurityDeployment["configured"]["frontend"],
      machineId: (row?.machine_id ?? null) as string | null,
    },
    updatedAt: row?.updated_at ? Number(row.updated_at) : null,
    revision: Number(row?.revision ?? 0),
  };
}
export async function saveDeployment(
  env: AuthEnvironment,
  value: unknown,
  actor: string,
) {
  const b = object(value);
  if (
    Object.keys(b).some(
      (k) =>
        !["provider", "ingress", "frontend", "machineId", "revision"].includes(
          k,
        ),
    ) ||
    !Number.isSafeInteger(b.revision) ||
    Number(b.revision) < 0
  )
    throw new AuthError("INVALID_DEPLOYMENT_METADATA");
  const provider = text(b.provider, 80, true).trim();
  if (
    !/^[\p{L}\p{N} ._()-]*$/u.test(provider) ||
    ![
      "unknown",
      "direct",
      "reverse-proxy",
      "cloudflare-proxy",
      "cloudflare-tunnel",
      "private",
    ].includes(String(b.ingress)) ||
    !["unknown", "same-runtime", "separate"].includes(String(b.frontend))
  )
    throw new AuthError("INVALID_DEPLOYMENT_METADATA");
  const machine =
    b.machineId === null || b.machineId === "" ? null : id(b.machineId);
  if (env.deployment?.runtime === "cloudflare-worker" && machine)
    throw new AuthError("WORKER_HAS_NO_HOST_MACHINE");
  const rows = await env.sql.query(
    `UPDATE ephor_security_deployment SET provider=$1,ingress=$2,frontend=$3,machine_id=$4,updated_at=$5,revision=revision+1 WHERE id=1 AND revision=$6 AND (CAST($4 AS TEXT) IS NULL OR EXISTS(SELECT 1 FROM ephor_machine WHERE id=$4 AND state='active')) RETURNING revision`,
    [provider, b.ingress, b.frontend, machine, Date.now(), b.revision],
  );
  if (!rows.length) throw new AuthError("DEPLOYMENT_METADATA_CHANGED", 409);
  await new Security(env.sql).event(
    crypto.randomUUID(),
    null,
    null,
    null,
    "panel",
    actor,
    "security.deployment.updated",
    "completed",
    JSON.stringify({
      provider,
      ingress: b.ingress,
      frontend: b.frontend,
      machineId: machine,
    }),
    Date.now(),
  );
  return deployment(env);
}
