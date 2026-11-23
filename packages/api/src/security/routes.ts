import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthError, AuthStore, hash } from "../auth/store";
import { releaseManifest } from "../machines/installer";
import { object } from "../services/spec";
import { securityActions } from "./actions";
import { securityAudit } from "./audit";
import { deployment, saveDeployment } from "./deployment";
import { securityCommand, securityInstaller } from "./installer";
import { Security } from "./store";

function bearer(header: string | undefined) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(header ?? "")?.[1];
  if (!token) throw new AuthError("INVALID_SECURITY_CREDENTIAL", 401);
  return token;
}
export function securityPublicRoutes(
  app: Hono,
  env: AuthEnvironment,
  clientIP: (r: Request) => string,
) {
  const security = new Security(env.sql),
    auth = new AuthStore(env.sql);
  app.get("/api/agent/security/install.sh", async (c) => {
    c.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return c.body(
      securityInstaller(
        env.origin,
        releaseManifest(await env.loadDaemonRelease?.()),
      ),
    );
  });
  app.post("/api/agent/security/enroll", async (c) => {
    await auth.limit("security-enrollment", 30);
    return c.json(
      await security.enroll(
        bearer(c.req.header("authorization")),
        object(await c.req.json()).credential,
      ),
    );
  });
  for (const action of ["next", "report", "events"] as const)
    app.post(`/api/agent/security/${action}`, async (c) => {
      let identity: Awaited<ReturnType<Security["identity"]>>;
      try {
        identity = await security.identity(
          bearer(c.req.header("authorization")),
        );
      } catch (error) {
        await auth.limit(
          `security-invalid:${await hash(env.secret + clientIP(c.req.raw))}`,
          30,
        );
        throw error;
      }
      await auth.limit(`security-agent:${identity.machineId}`, 600);
      const body = object(await c.req.json());
      if (action === "next")
        return c.json({
          job: await security.next(
            identity.machineId,
            identity.digest,
            body.version,
          ),
        });
      if (action === "report")
        return c.json({
          ok: true,
          pending: !!(await security.report(
            identity.machineId,
            identity.digest,
            body,
          )),
        });
      else await security.events(identity.machineId, identity.digest, body);
      return c.json({ ok: true });
    });
}
export function securityOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const security = new Security(env.sql),
    auth = new AuthStore(env.sql);
  const owner = (headers: Headers, fresh = true) =>
    requireOwner(createAuth(env, headers), auth, headers, fresh);
  app.get("/api/security/deployment", async (c) =>
    c.json(await deployment(env)),
  );
  app.post("/api/security/deployment", async (c) => {
    const actor = await owner(c.req.raw.headers);
    return c.json(
      await saveDeployment(env, await c.req.json(), actor.user.name),
    );
  });
  app.get("/api/security/overview", async (c) => {
    let available = false;
    try {
      available =
        releaseManifest(await env.loadDaemonRelease?.()).securityProtocol === 1;
    } catch {
      /* The overview remains usable without installer artifacts. */
    }
    return c.json(
      await security.overview(available, new URL(c.req.url).searchParams),
    );
  });
  app.get("/api/security/findings", async (c) =>
    c.json(await security.findings(new URL(c.req.url).searchParams)),
  );
  app.get("/api/security/actions", async (c) =>
    c.json(await securityActions(env.sql, new URL(c.req.url).searchParams)),
  );
  app.post("/api/security/findings/:id", async (c) => {
    const actor = await owner(c.req.raw.headers);
    await security.updateFinding(
      c.req.param("id"),
      await c.req.json(),
      actor.user.name,
    );
    return c.json({ ok: true });
  });
  app.get("/api/security/audit", async (c) =>
    c.json(await securityAudit(env.sql, new URL(c.req.url).searchParams)),
  );
  app.get("/api/security/export", async (c) => {
    // Export is paginated with the same cursor as the timeline, so no silent truncation.
    const data = await securityAudit(env.sql, new URL(c.req.url).searchParams);
    c.header(
      "Content-Disposition",
      'attachment; filename="ephor-security-audit.json"',
    );
    return c.json(data);
  });
  app.post("/api/security/scan", async (c) => {
    await auth.limit("security-manual-scan", 10);
    const b = object(await c.req.json());
    return c.json({ scan: await security.queue(b.machineId, b.serviceId) });
  });
  app.post("/api/security/collector", async (c) => {
    await owner(c.req.raw.headers);
    await auth.limit("security-enrollment-issue", 10);
    const b = object(await c.req.json());
    securityInstaller(
      env.origin,
      releaseManifest(await env.loadDaemonRelease?.()),
    );
    const ticket = await security.issue(b.machineId);
    return c.json({
      command: securityCommand(env.origin, ticket.token),
      expiresAt: ticket.expiresAt,
    });
  });
  app.post("/api/security/collector/revoke", async (c) => {
    await owner(c.req.raw.headers);
    await security.revoke(object(await c.req.json()).machineId);
    return c.json({ ok: true });
  });
  app.post("/api/security/settings", async (c) => {
    await owner(c.req.raw.headers);
    const days = object(await c.req.json()).retentionDays;
    if (typeof days !== "number" || ![7, 30, 90, 180, 365].includes(days))
      throw new AuthError("INVALID_SECURITY_RETENTION");
    await env.sql.query(
      "UPDATE ephor_security_settings SET retention_days=$1,maintenance_at=0 WHERE id=1",
      [days],
    );
    return c.json({ ok: true });
  });
}
