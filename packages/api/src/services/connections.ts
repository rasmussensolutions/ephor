import { AuthError, type Sql } from "../auth/store";
import type { ServiceSecrets } from "./crypto";
import { type ServiceSpec, spec } from "./spec";
import type { ServiceRow } from "./store";

// References are whole values, never arbitrary interpolation or executable expressions.
export function connectionReference(value: string) {
  const match = /^\$\{\{([a-f0-9-]{36})\.(DATABASE_URL|REDIS_URL)\}\}$/.exec(
    value,
  );
  if (!match) {
    if (value.includes("${{"))
      throw new AuthError("INVALID_VARIABLE_REFERENCE");
    return null;
  }
  return { serviceId: match[1] as string, variable: match[2] as string };
}
export function referenceValue(serviceId: string, variable: string) {
  return `\${{${serviceId}.${variable}}}`;
}
/** Map metadata contains destinations and variable names, never values. */
export function variableConnections(config: ServiceSpec) {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of Object.entries(config.environment)) {
    const ref = connectionReference(value);
    if (!ref) continue;
    const variables = grouped.get(ref.serviceId) ?? [];
    variables.push(name);
    grouped.set(ref.serviceId, variables);
  }
  return [...grouped].map(([serviceId, variables]) => ({
    serviceId,
    variables: variables.sort(),
  }));
}
function exported(config: ServiceSpec) {
  if (config.catalog?.version !== 1) return null;
  if (config.catalog.template === "postgres")
    return {
      template: "postgres" as const,
      variable: "DATABASE_URL",
      component: "database",
    };
  if (config.catalog.template === "redis")
    return {
      template: "redis" as const,
      variable: "REDIS_URL",
      component: "redis",
    };
  return null;
}

export class ServiceConnections {
  constructor(
    private sql: Sql,
    private secrets: ServiceSecrets,
  ) {}

  async pending(
    row: Pick<ServiceRow, "id" | "machine_id">,
    config: ServiceSpec,
    deployed: ServiceSpec | null,
  ) {
    if (config.catalog) return false;
    if (!deployed) return Object.keys(config.environment).length > 0;
    try {
      const resolved = await this.resolve(row, config);
      const names = Object.keys(resolved.environment);
      if (
        names.length !== Object.keys(deployed.environment).length ||
        names.some(
          (name) => resolved.environment[name] !== deployed.environment[name],
        )
      )
        return true;
      const grants = (s: ServiceSpec) =>
        (s.connections ?? []).map((c) => `${c.serviceId}:${c.template}`).sort();
      return (
        JSON.stringify(grants(resolved)) !== JSON.stringify(grants(deployed))
      );
    } catch (error) {
      // A removed source leaves a saved link unapplied, without breaking reads.
      if (error instanceof AuthError) return true;
      throw error;
    }
  }

  async suggestions(row: Pick<ServiceRow, "id" | "machine_id">) {
    const rows = await this.sql.query<ServiceRow>(
      "SELECT * FROM ephor_service WHERE machine_id=$1 AND id<>$2 ORDER BY name,id",
      [row.machine_id, row.id],
    );
    const suggestions = [];
    for (const source of rows) {
      const config = await this.secrets.open<ServiceSpec>(
        source.id,
        source.config,
      );
      const item = exported(config);
      if (!item) continue;
      suggestions.push({
        serviceId: source.id,
        serviceName: source.name,
        template: item.template,
        variable: item.variable,
        reference: referenceValue(source.id, item.variable),
      });
    }
    return suggestions;
  }

  async resolve(
    row: Pick<ServiceRow, "id" | "machine_id">,
    config: ServiceSpec,
  ): Promise<ServiceSpec> {
    const environment = { ...config.environment };
    const connections = new Map<
      string,
      NonNullable<ServiceSpec["connections"]>[number]
    >();
    const sources = new Map<string, { config: ServiceSpec; row: ServiceRow }>();
    for (const [name, value] of Object.entries(environment)) {
      const ref = connectionReference(value);
      if (!ref) continue;
      if (config.catalog || ref.serviceId === row.id)
        throw new AuthError("INVALID_VARIABLE_REFERENCE");
      let source = sources.get(ref.serviceId);
      if (!source) {
        const [sourceRow] = await this.sql.query<ServiceRow>(
          "SELECT * FROM ephor_service WHERE id=$1 AND machine_id=$2",
          [ref.serviceId, row.machine_id],
        );
        if (!sourceRow)
          throw new AuthError("CONNECTION_SOURCE_UNAVAILABLE", 409);
        source = {
          row: sourceRow,
          config: await this.secrets.open<ServiceSpec>(
            sourceRow.id,
            sourceRow.config,
          ),
        };
        sources.set(ref.serviceId, source);
      }
      const item = exported(source.config);
      const password = source.config.environment.DB_PASSWORD;
      if (!item || ref.variable !== item.variable || !password)
        throw new AuthError("CONNECTION_SOURCE_UNAVAILABLE", 409);
      const host = `ephor-app-${source.row.id}-${item.component}`;
      environment[name] =
        item.template === "postgres"
          ? `postgresql://ephor:${encodeURIComponent(password)}@${host}:5432/app`
          : `redis://:${encodeURIComponent(password)}@${host}:6379/0`;
      connections.set(source.row.id, {
        serviceId: source.row.id,
        template: item.template,
      });
    }
    // Validate the resolved size too. Network grants only originate here, never in client input.
    const resolved = spec({ ...config, environment });
    if (connections.size) resolved.connections = [...connections.values()];
    return resolved;
  }
}
