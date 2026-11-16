import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthStore } from "../auth/store";
import { object } from "../services/spec";
import { AiIntegration } from "./store";

export function aiOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const ai = new AiIntegration(env.sql, env.secret);
  app.get("/api/integrations/ai", async (c) => c.json(await ai.status()));
  app.get("/api/integrations/ai/models", async (c) =>
    c.json(await ai.models()),
  );
  for (const action of ["connect", "disconnect"] as const) {
    app.post(`/api/integrations/ai/${action}`, async (c) => {
      await requireOwner(
        createAuth(env, c.req.raw.headers),
        new AuthStore(env.sql),
        c.req.raw.headers,
        true,
      );
      return c.json(
        action === "connect"
          ? await ai.save(await c.req.json())
          : await ai.disconnect(),
      );
    });
  }
  app.post("/api/services/:id/diagnose-build", async (c) => {
    const body = object(await c.req.json());
    return c.json(await ai.diagnose(c.req.param("id"), body.buildId));
  });
}
