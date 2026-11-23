import type { Hono } from "hono";
import {
  type AuthEnvironment,
  createAuth,
  requireOwner,
} from "../../auth/config";
import { AuthError, AuthStore } from "../../auth/store";
import { sha256 } from "./manifest";
import { PanelReleases } from "./updates";
export function panelReleasePublicRoutes(app: Hono, env: AuthEnvironment) {
  app.post("/api/panel-updater/poll", async (c) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
    if (
      !env.panelUpdaterToken ||
      !token ||
      token.length > 512 ||
      (await sha256(new TextEncoder().encode(token))) !==
        (await sha256(new TextEncoder().encode(env.panelUpdaterToken)))
    )
      throw new AuthError("UNAUTHORIZED", 401);
    return c.json(await new PanelReleases(env).updater(await c.req.json()));
  });
}
export function panelReleaseOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const panel = new PanelReleases(env),
    store = new AuthStore(env.sql);
  app.use("/api/panel/*", async (c, next) => {
    if (c.req.method !== "GET")
      await requireOwner(
        createAuth(env, c.req.raw.headers),
        store,
        c.req.raw.headers,
        true,
      );
    await next();
  });
  app.get("/api/panel/status", async (c) => c.json(await panel.status()));
  app.post("/api/panel/configure", async (c) => {
    await panel.configure(await c.req.json());
    return c.json(await panel.status());
  });
  app.post("/api/panel/check", async (c) => {
    await store.limit("panel-release-check", 5);
    await panel.check();
    return c.json(await panel.status());
  });
  app.post("/api/panel/install", async (c) => {
    await panel.install(await c.req.json());
    return c.json(await panel.status());
  });
}
