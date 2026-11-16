import type { Hono } from "hono";
import type { AuthEnvironment } from "../auth/config";
import { AuthError } from "../auth/store";
import { object } from "../services/spec";

function projectName(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /\p{Cc}/u.test(value)
  )
    throw new AuthError("INVALID_PROJECT_NAME");
  return value.trim();
}

export function projectOwnerRoutes(app: Hono, env: AuthEnvironment) {
  const sql = env.sql;
  async function get(id: string) {
    const row = (
      await sql.query<{ id: string; name: string }>(
        "SELECT id,name FROM ephor_project WHERE id=$1",
        [id],
      )
    )[0];
    if (!row) throw new AuthError("PROJECT_NOT_FOUND", 404);
    return row;
  }
  app.get("/api/projects", async (c) => {
    const [projects, memberships] = await Promise.all([
      sql.query<{ id: string; name: string }>(
        "SELECT id,name FROM ephor_project ORDER BY name,id",
      ),
      sql.query<{ project_id: string; service_id: string }>(
        "SELECT project_id,service_id FROM ephor_project_service",
      ),
    ]);
    return c.json({
      projects: projects.map((p) => ({
        ...p,
        serviceIds: memberships
          .filter((m) => m.project_id === p.id)
          .map((m) => m.service_id),
      })),
    });
  });
  app.post("/api/projects/create", async (c) => {
    const name = projectName(object(await c.req.json()).name);
    const id = crypto.randomUUID();
    await sql.query(
      "INSERT INTO ephor_project(id,name,created_at) VALUES($1,$2,$3)",
      [id, name, Date.now()],
    );
    return c.json({ id, name, serviceIds: [] }, 201);
  });
  app.get("/api/projects/:id", async (c) => {
    const project = await get(c.req.param("id"));
    const rows = await sql.query<{ service_id: string }>(
      "SELECT service_id FROM ephor_project_service WHERE project_id=$1",
      [project.id],
    );
    return c.json({ ...project, serviceIds: rows.map((r) => r.service_id) });
  });
  app.post("/api/projects/:id/rename", async (c) => {
    const name = projectName(object(await c.req.json()).name);
    const rows = await sql.query(
      "UPDATE ephor_project SET name=$1 WHERE id=$2 RETURNING id",
      [name, c.req.param("id")],
    );
    if (!rows.length) throw new AuthError("PROJECT_NOT_FOUND", 404);
    return c.json({ ok: true });
  });
  app.post("/api/projects/:id/add", async (c) => {
    const project = await get(c.req.param("id"));
    const serviceId = object(await c.req.json()).serviceId;
    if (typeof serviceId !== "string")
      throw new AuthError("SERVICE_NOT_FOUND", 404);
    // The single statement also checks existence at write time. Membership is
    // unique per service, so concurrent additions cannot move another project’s service.
    await sql.query(
      `INSERT INTO ephor_project_service(project_id,service_id)
      SELECT p.id,s.id FROM ephor_project p CROSS JOIN ephor_service s
      WHERE p.id=$1 AND s.id=$2 ON CONFLICT(service_id) DO NOTHING`,
      [project.id, serviceId],
    );
    const row = (
      await sql.query<{ project_id: string }>(
        "SELECT project_id FROM ephor_project_service WHERE service_id=$1",
        [serviceId],
      )
    )[0];
    if (!row) throw new AuthError("PROJECT_OR_SERVICE_NOT_FOUND", 404);
    if (row.project_id !== project.id)
      throw new AuthError("SERVICE_ALREADY_IN_PROJECT", 409);
    return c.json({ ok: true });
  });
  app.post("/api/projects/:id/remove", async (c) => {
    await get(c.req.param("id"));
    const serviceId = object(await c.req.json()).serviceId;
    if (typeof serviceId !== "string")
      throw new AuthError("SERVICE_NOT_FOUND", 404);
    await sql.query(
      "DELETE FROM ephor_project_service WHERE project_id=$1 AND service_id=$2",
      [c.req.param("id"), serviceId],
    );
    return c.json({ ok: true });
  });
  app.post("/api/projects/:id/delete", async (c) => {
    await sql.query("DELETE FROM ephor_project WHERE id=$1", [
      c.req.param("id"),
    ]);
    return c.json({ ok: true });
  });
}
