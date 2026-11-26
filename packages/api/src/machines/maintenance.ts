import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import {
  AuthError,
  AuthStore,
  hash,
  randomToken,
  type Sql,
} from "../auth/store";
import { protectionInstaller } from "../protections/installer";
import { Protections } from "../protections/store";
import { securityInstaller } from "../security/installer";
import { Security } from "../security/store";
import { serviceInstaller } from "../services/installer";
import { Services } from "../services/store";
import {
  type DaemonRelease,
  maintenanceLock,
  releaseManifest,
  shellQuote,
  updaterSetup,
} from "./installer";
import { machineClaim } from "./maintenance-lock";
import { maintenanceStatus } from "./maintenance-status";
import { componentInventory, maintenanceBusy } from "./updates";

export function maintenanceCommand(
  origin: string,
  worker: string,
  security: string,
  protection: string,
  lease: string,
) {
  const tokens = [worker, security, protection, lease]
    .map(shellQuote)
    .join(" ");
  return `(set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/maintenance.sh`)} -o "$f"; if [ "$(id -u)" = 0 ]; then printf '%s\\n' ${tokens} | sh "$f"; else sudo -v; printf '%s\\n' ${tokens} | sudo sh "$f"; fi)`;
}
export function maintenanceInstaller(
  origin: string,
  release: DaemonRelease,
  key?: string,
) {
  if (
    release.updaterProtocol !== 3 ||
    Number(release.serviceProtocol) < 6 ||
    release.securityProtocol !== 1 ||
    release.protectionProtocol !== 1 ||
    release.managedUpdatesProtocol !== 2
  )
    throw new AuthError("MAINTENANCE_BUILD_REQUIRED", 409);
  if (!key) throw new AuthError("UPDATES_NOT_CONFIGURED", 503);
  const updater = updaterSetup(origin, key, "/usr/local/bin/ephord", 3);
  const steps = `set -eu
IFS= read -r worker_token
IFS= read -r security_token
IFS= read -r protection_token
"$1" recover-layout
"$1" configure-updater ${shellQuote(key)} ${shellQuote(origin)} "$2"
"$1" migrate-layout
(sh -c ${shellQuote(updater)})
printf '%s\\n' "$worker_token" | sh -c ${shellQuote(serviceInstaller(origin, release))}
printf '%s\\n' "$security_token" | sh -c ${shellQuote(securityInstaller(origin, release))}
if [ -n "$protection_token" ]; then
  printf '%s\\n' "$protection_token" | sh -c ${shellQuote(protectionInstaller(origin, release))}
fi
`;
  return `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || exit 1
command -v timeout >/dev/null
${maintenanceLock()}
IFS= read -r worker_token
IFS= read -r security_token
IFS= read -r protection_token
IFS= read -r lease_token
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
case "$(uname -m)" in
 x86_64) arch=x86_64; expected=${shellQuote(release.x86_64 ?? "")} ;;
 aarch64|arm64) arch=aarch64; expected=${shellQuote(release.aarch64 ?? "")} ;;
 *) exit 1 ;;
esac
[ -n "$expected" ]
curl --fail --silent --show-error --proto '=https' --max-time 300 ${shellQuote(`${origin}/daemon/`)}"ephord-linux-$arch" -o "$tmp/ephord"
printf '%s  %s\\n' "$expected" "$tmp/ephord" | sha256sum --check --status
chmod 0700 "$tmp/ephord"
version=$(/usr/local/bin/ephord --version); version="\${version#ephord }"
if [ ! -e /etc/ephor/updater.json ]; then
 "$tmp/ephord" configure-updater ${shellQuote(key)} ${shellQuote(origin)} "$version"
fi
printf '%s\\n' "$lease_token" | "$tmp/ephord" maintenance-start
trap 'printf "%s\\n" "$lease_token" | "$tmp/ephord" maintenance-end || true; rm -rf "$tmp"' EXIT
# The server lease lasts an hour. Stop local setup before it can expire.
printf '%s\\n' "$worker_token" "$security_token" "$protection_token" | timeout 3300 sh -c ${shellQuote(steps)} setup "$tmp/ephord" "$version"
echo 'Ephor maintenance is ready. Return to this machine’s Maintenance tab to update all installed components.'
`;
}

export async function maintenanceLease(
  sql: Sql,
  machine: string,
  value: unknown,
  start: boolean,
) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new AuthError("INVALID_MAINTENANCE_GRANT", 401);
  const digest = await hash(value);
  if (!start) {
    await sql.query(
      "UPDATE ephor_machine SET maintenance_until=0,maintenance_token_hash=NULL,maintenance_expires=0 WHERE id=$1 AND maintenance_token_hash=$2",
      [machine, digest],
    );
    return;
  }
  const granted = await machineClaim(sql, machine, async () => {
    const rows = await sql.query(
      "UPDATE ephor_machine SET maintenance_until=$3 WHERE id=$1 AND state='active' AND maintenance_token_hash=$2 AND maintenance_expires>$4 AND maintenance_until<=$4 RETURNING id",
      [machine, digest, Date.now() + 3600000, Date.now()],
    );
    if (!rows.length) throw new AuthError("INVALID_MAINTENANCE_GRANT", 409);
    const [update] = await sql.query(
      "SELECT id FROM ephor_update WHERE machine_id=$1 AND ((status IN ('queued','downloading') AND expires_at>$2) OR status='installing' OR (status='expired' AND install_started=1))",
      [machine, Date.now()],
    );
    if (update || (await maintenanceBusy(sql, machine))) {
      await sql.query(
        "UPDATE ephor_machine SET maintenance_until=0 WHERE id=$1 AND maintenance_token_hash=$2",
        [machine, digest],
      );
      throw new AuthError("MACHINE_BUSY", 409);
    }
    return true;
  });
  if (!granted) throw new AuthError("MACHINE_BUSY", 409);
}

export function maintenanceOwnerRoutes(app: Hono, env: AuthEnvironment) {
  app.get("/api/machines/:id/maintenance/status", async (c) =>
    c.json(await maintenanceStatus(env.sql, c.req.param("id"))),
  );
  app.post("/api/machines/maintenance/policy", async (c) => {
    await requireOwner(
      createAuth(env, c.req.raw.headers),
      new AuthStore(env.sql),
      c.req.raw.headers,
      true,
    );
    const body = await c.req.json();
    if (
      typeof body?.id !== "string" ||
      body.id.length > 64 ||
      !["manual", "automatic", "pinned"].includes(body.policy)
    )
      throw new AuthError("INVALID_EPHOR_UPDATE_POLICY");
    const result = await machineClaim(env.sql, body.id, async () => {
      const [machine] = await env.sql.query(
        "SELECT updater_protocol,updater_components,updater_seen,maintenance_until FROM ephor_machine WHERE id=$1 AND state='active'",
        [body.id],
      );
      if (
        !machine ||
        Number(machine.updater_protocol) !== 3 ||
        Number(machine.updater_seen) < Date.now() - 180000
      )
        throw new AuthError("MAINTENANCE_SETUP_REQUIRED", 409);
      const inventory = componentInventory(
        JSON.parse(String(machine.updater_components)),
      );
      const version = inventory.find((c) => c.id === "monitoring")?.version;
      if (!version) throw new AuthError("MAINTENANCE_SETUP_REQUIRED", 409);
      if (Number(machine.maintenance_until) > Date.now())
        throw new AuthError("MACHINE_BUSY", 409);
      const [job] = await env.sql.query(
        "SELECT id FROM ephor_update WHERE machine_id=$1 AND status IN ('queued','downloading','installing','expired') AND (status!='expired' OR install_started=1)",
        [body.id],
      );
      if (job) throw new AuthError("UPDATE_ALREADY_RUNNING", 409);
      await env.sql.query(
        "UPDATE ephor_machine SET update_policy=$2,pinned_version=$3 WHERE id=$1",
        [body.id, body.policy, body.policy === "pinned" ? version : null],
      );
      await new AuthStore(env.sql).audit(
        `machine.update_policy_${body.policy}`,
        body.id,
      );
      return true;
    });
    if (!result) throw new AuthError("MACHINE_BUSY", 409);
    return c.json({ ok: true });
  });
  app.post("/api/machines/maintenance/setup", async (c) => {
    const actor = await requireOwner(
      createAuth(env, c.req.raw.headers),
      new AuthStore(env.sql),
      c.req.raw.headers,
      true,
    );
    const body = await c.req.json();
    if (
      typeof body?.id !== "string" ||
      body.id.length > 64 ||
      (body.protections !== undefined && typeof body.protections !== "boolean")
    )
      throw new AuthError("INVALID_ID");
    const release = releaseManifest(await env.loadDaemonRelease?.());
    maintenanceInstaller(
      env.origin,
      release,
      env.releaseUrl ? env.releasePublicKey : undefined,
    );
    if (await maintenanceBusy(env.sql, body.id))
      throw new AuthError("MACHINE_BUSY", 409);
    const [setup] = await env.sql.query(
      "SELECT id FROM ephor_machine WHERE id=$1 AND maintenance_until>$2",
      [body.id, Date.now()],
    );
    if (setup) throw new AuthError("MACHINE_BUSY", 409);
    const [running] = await env.sql.query(
      "SELECT id FROM ephor_update WHERE machine_id=$1 AND ((status IN ('queued','downloading') AND expires_at>$2) OR status='installing' OR (status='expired' AND install_started=1))",
      [body.id, Date.now()],
    );
    if (running) throw new AuthError("UPDATE_ALREADY_RUNNING", 409);
    const [existing] = await env.sql.query(
      "SELECT enabled FROM ephor_protection_agent WHERE machine_id=$1",
      [body.id],
    );
    const lease = randomToken();
    const granted = await env.sql.query(
      "UPDATE ephor_machine SET maintenance_token_hash=$2,maintenance_expires=$3 WHERE id=$1 AND state='active' AND maintenance_until<=$4 RETURNING id",
      [body.id, await hash(lease), Date.now() + 600000, Date.now()],
    );
    if (!granted.length) throw new AuthError("MACHINE_BUSY", 409);
    const worker = await new Services(env.sql, env.secret).issueWorker(body.id);
    const security = await new Security(env.sql).issue(body.id);
    const protection =
      body.protections === true || Number(existing?.enabled) === 1
        ? await new Protections(env.sql).issue(body.id, actor.user.name, true)
        : null;
    await new AuthStore(env.sql).audit("machine.maintenance_setup", body.id);
    return c.json({
      command: maintenanceCommand(
        env.origin,
        worker,
        security.token,
        protection?.token ?? "",
        lease,
      ),
      expiresAt: Date.now() + 600000,
    });
  });
}
