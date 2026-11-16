import { AuthError, AuthStore, type Sql } from "../auth/store";
import { template } from "./catalog";
import { object, type ServiceSpec } from "./spec";
import { Services } from "./store";

export const groupColors = [
  "neutral",
  "blue",
  "violet",
  "green",
  "amber",
  "rose",
] as const;
export interface ServicePresentation {
  groupName: string;
  groupColor: (typeof groupColors)[number];
  componentNames: Record<string, string>;
  positions?: Record<string, { x: number; y: number; revision?: number }>;
}
function displayName(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /\p{Cc}/u.test(value)
  )
    throw new AuthError("INVALID_DISPLAY_NAME");
  return value.trim();
}
export async function updatePresentation(
  sql: Sql,
  secret: string,
  id: unknown,
  body: unknown,
) {
  const services = new Services(sql, secret),
    row = await services.get(id),
    b = object(body);
  const allowed = ["name", "groupName", "groupColor", "component", "position"];
  if (
    !Object.keys(b).length ||
    Object.keys(b).some((key) => !allowed.includes(key))
  )
    throw new AuthError("INVALID_PRESENTATION");
  const config = await services.secrets.open<ServiceSpec>(row.id, row.config);
  const recipe = config.catalog
    ? template(config.catalog.template, config.catalog.version)
    : undefined;
  if (b.position !== undefined) {
    const point = object(b.position);
    if (
      Object.keys(b).length !== 1 ||
      Object.keys(point).some(
        (key) => !["x", "y", "component"].includes(key),
      ) ||
      ![point.x, point.y].every(
        (value) =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 20000,
      )
    )
      throw new AuthError("INVALID_MAP_POSITION");
    if (
      point.component !== undefined &&
      (typeof point.component !== "string" ||
        !recipe ||
        recipe.components.length < 2 ||
        !recipe.components.some(
          (component) => component.id === point.component,
        ))
    )
      throw new AuthError("COMPONENT_NOT_FOUND", 404);
    // Each card has its own row: moving one never overwrites a sibling's position.
    await sql.query(
      "INSERT INTO ephor_service_map_position (service_id,component_id,x,y) VALUES ($1,$2,$3,$4) ON CONFLICT (service_id,component_id) DO UPDATE SET x=excluded.x,y=excluded.y,revision=ephor_service_map_position.revision+1",
      [row.id, point.component ?? "", point.x, point.y],
    );
    await new AuthStore(sql).audit("service.layout_updated", row.id);
    return (await services.list(row.id, true))[0];
  }
  const values: (string | number | null)[] = [];
  const assignments: string[] = [];
  const set = (column: string, value: string) => {
    values.push(value);
    assignments.push(`${column}=$${values.length}`);
  };
  if (b.name !== undefined) set("name", displayName(b.name));
  if (b.groupName !== undefined || b.groupColor !== undefined) {
    if (!recipe || recipe.components.length < 2)
      throw new AuthError("SERVICE_GROUP_NOT_FOUND", 404);
    if (b.groupName !== undefined) set("group_name", displayName(b.groupName));
    if (b.groupColor !== undefined) {
      if (!groupColors.includes(b.groupColor as (typeof groupColors)[number]))
        throw new AuthError("INVALID_GROUP_COLOR");
      set("group_color", String(b.groupColor));
    }
  }
  if (b.component !== undefined) {
    const component = object(b.component);
    if (!recipe?.components.some((c) => c.id === component.id))
      throw new AuthError("COMPONENT_NOT_FOUND", 404);
    if (component.id === recipe.components.at(-1)?.id || b.name !== undefined)
      throw new AuthError("INVALID_PRESENTATION");
    const names: Record<string, string> = JSON.parse(
      row.component_names ?? "{}",
    );
    names[String(component.id)] = displayName(component.name);
    set("component_names", JSON.stringify(names));
  }
  if (!assignments.length) throw new AuthError("INVALID_PRESENTATION");
  values.push(row.id);
  let where = `id=$${values.length}`;
  if (b.component !== undefined) {
    values.push(row.component_names ?? "{}");
    where += ` AND component_names=$${values.length}`;
  }
  const result = await sql.query(
    `UPDATE ephor_service SET ${assignments.join(",")} WHERE ${where} RETURNING id`,
    values,
  );
  if (!result.length) throw new AuthError("PRESENTATION_CHANGED", 409);
  await new AuthStore(sql).audit("service.presentation_updated", row.id);
  return (await services.list(row.id, true))[0];
}
