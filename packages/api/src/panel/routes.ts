import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthError, AuthStore } from "../auth/store";
import { PanelUpdates } from "./updates";

export function panelOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const panel = new PanelUpdates(env),
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
  app.get("/api/panel/status", async (c) =>
    c.json(await panel.status(c.req.query("live") === "1")),
  );
  app.get("/api/panel/github", async (c) =>
    c.json(await panel.github.status()),
  );
  app.post("/api/panel/github/start", async (c) =>
    c.json(await panel.github.start()),
  );
  app.post("/api/panel/github/finish", async (c) =>
    c.json(await panel.github.finish(await c.req.json())),
  );
  app.post("/api/panel/github/disconnect", async (c) => {
    await panel.change(async (state, save) => {
      await panel.github.disconnect();
      delete state.config;
      delete state.job;
      await save();
    });
    return c.json({ ok: true });
  });
  app.get("/api/panel/github/repositories", async (c) => {
    const page = Number(c.req.query("page") ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw new AuthError("INVALID_PAGE");
    return c.json(
      await panel.github.repositories(c.req.query("installation") ?? "", page),
    );
  });
  app.post("/api/panel/configure", async (c) => {
    await panel.configure(await c.req.json());
    return c.json(await panel.status());
  });
  app.post("/api/panel/check", async (c) => {
    await store.limit("panel-check", 5);
    await panel.check();
    return c.json(await panel.status());
  });
  app.post("/api/panel/prepare", async (c) => {
    await panel.prepare();
    return c.json(await panel.status());
  });
  app.post("/api/panel/review", async (c) => {
    await panel.review();
    return c.json(await panel.status(true));
  });
  app.post("/api/panel/install", async (c) => {
    await panel.install(await c.req.json());
    return c.json(await panel.status(true));
  });
  app.post("/api/panel/reset", async (c) => {
    await panel.reset();
    return c.json(await panel.status());
  });
}
