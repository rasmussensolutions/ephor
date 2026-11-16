import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthStore } from "../auth/store";
import { object } from "../services/spec";
import { Backups } from "./store";
export function backupOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const backups = new Backups(env.sql, env.secret);
  app.get("/api/backups", async (c) => c.json(await backups.list()));
  app.use("/api/backups/*", async (c, next) => {
    if (c.req.method !== "GET")
      await requireOwner(
        createAuth(env, c.req.raw.headers),
        new AuthStore(env.sql),
        c.req.raw.headers,
        true,
      );
    await next();
  });
  app.post("/api/backups/destinations", async (c) =>
    c.json(await backups.createDestination(await c.req.json())),
  );
  app.post("/api/backups/destinations/:id/check", async (c) =>
    c.json(
      await backups.checkDestination(
        c.req.param("id"),
        object(await c.req.json()).machineId,
      ),
    ),
  );
  app.post("/api/backups/destinations/:id/credentials", async (c) =>
    c.json(await backups.credentials(c.req.param("id"), await c.req.json())),
  );
  app.post("/api/backups/plans", async (c) =>
    c.json(await backups.configure(await c.req.json())),
  );
  app.post("/api/backups/plans/:id/run", async (c) =>
    c.json(await backups.queue(c.req.param("id"))),
  );
  app.post("/api/backups/plans/:id/recovery", async (c) =>
    c.json(await backups.recovery(c.req.param("id"))),
  );
  app.post("/api/backups/restore", async (c) =>
    c.json(await backups.restore(await c.req.json())),
  );
}
