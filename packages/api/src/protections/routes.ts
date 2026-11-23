import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthError, AuthStore, hash } from "../auth/store";
import { releaseManifest } from "../machines/installer";
import { object } from "../services/spec";
import { protectionCommand, protectionInstaller } from "./installer";
import { Protections } from "./store";

function bearer(value?: string) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(value ?? "")?.[1];
  if (!token) throw new AuthError("INVALID_PROTECTION_CREDENTIAL", 401);
  return token;
}
export function protectionPublicRoutes(
  app: Hono,
  env: AuthEnvironment,
  clientIP: (r: Request) => string,
) {
  const store = new Protections(env.sql),
    auth = new AuthStore(env.sql);
  app.get("/api/agent/protections/install.sh", async (c) => {
    c.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return c.body(
      protectionInstaller(
        env.origin,
        releaseManifest(await env.loadDaemonRelease?.()),
      ),
    );
  });
  app.post("/api/agent/protections/enroll", async (c) => {
    await auth.limit("protection-enrollment", 30);
    return c.json(
      await store.enroll(
        bearer(c.req.header("authorization")),
        object(await c.req.json()).credential,
      ),
    );
  });
  for (const action of ["next", "report"] as const)
    app.post(`/api/agent/protections/${action}`, async (c) => {
      let identity: Awaited<ReturnType<Protections["identity"]>>;
      try {
        identity = await store.identity(bearer(c.req.header("authorization")));
      } catch (error) {
        await auth.limit(
          `protection-invalid:${await hash(env.secret + clientIP(c.req.raw))}`,
          30,
        );
        throw error;
      }
      await auth.limit(`protection-agent:${identity.machineId}`, 240);
      const b = object(await c.req.json());
      if (action === "next")
        return c.json(
          await store.next(identity.machineId, identity.digest, b.snapshot),
        );
      await store.report(identity.machineId, identity.digest, b);
      return c.json({ ok: true });
    });
}
export function protectionOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const store = new Protections(env.sql),
    auth = new AuthStore(env.sql);
  const owner = (h: Headers) => requireOwner(createAuth(env, h), auth, h, true);
  app.get("/api/security/protections", async (c) => {
    let installerAvailable = false;
    try {
      const release = releaseManifest(await env.loadDaemonRelease?.());
      installerAvailable =
        release.protectionProtocol === 1 &&
        release.managedUpdatesProtocol === 2;
    } catch {
      /* status remains available */
    }
    return c.json({
      machines: await store.list(c.req.query("machine")),
      installerAvailable,
    });
  });
  app.post("/api/security/protections/enrollment", async (c) => {
    const actor = await owner(c.req.raw.headers);
    await auth.limit("protection-grants", 10);
    protectionInstaller(
      env.origin,
      releaseManifest(await env.loadDaemonRelease?.()),
    );
    const ticket = await store.issue(
      object(await c.req.json()).machineId,
      actor.user.name,
    );
    return c.json({
      command: protectionCommand(env.origin, ticket.token),
      expiresAt: ticket.expiresAt,
    });
  });
  app.post("/api/security/protections/revoke", async (c) => {
    const actor = await owner(c.req.raw.headers);
    await store.revoke(object(await c.req.json()).machineId, actor.user.name);
    return c.json({ ok: true });
  });
  app.post("/api/security/protections/plan", async (c) => {
    const actor = await owner(c.req.raw.headers);
    await auth.limit("protection-plans", 30);
    return c.json(await store.plan(await c.req.json(), actor.user.name));
  });
  app.post("/api/security/protections/approve", async (c) => {
    const actor = await owner(c.req.raw.headers);
    await auth.limit("protection-approval", 20);
    return c.json(
      await store.approve(object(await c.req.json()).id, actor.user.name),
    );
  });
}
