import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthStore } from "../auth/store";
import { Notifications } from "./store";
export function notificationOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const notifications = new Notifications(env.sql, env.secret, env.origin);
  app.get("/api/notifications", async (c) =>
    c.json(
      await notifications.list(
        c.req.query("view") ?? "inbox",
        c.req.query("before"),
      ),
    ),
  );
  app.get("/api/notifications/settings", async (c) =>
    c.json(await notifications.settings()),
  );
  app.post("/api/notifications/read", async (c) =>
    c.json(await notifications.read(await c.req.json())),
  );
  for (const path of ["settings", "test"])
    app.use(`/api/notifications/${path}`, async (c, next) => {
      if (c.req.method !== "GET")
        await requireOwner(
          createAuth(env, c.req.raw.headers),
          new AuthStore(env.sql),
          c.req.raw.headers,
          true,
        );
      await next();
    });
  app.post("/api/notifications/settings", async (c) =>
    c.json(await notifications.save(await c.req.json())),
  );
  app.post("/api/notifications/test", async (c) =>
    c.json(await notifications.test(await c.req.json())),
  );
}
