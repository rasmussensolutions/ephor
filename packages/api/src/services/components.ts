import { AuthError, AuthStore, hash, type Sql } from "../auth/store";
import { template } from "./catalog";
import { metricsHistory } from "./metrics";
import { object, type ServiceSpec } from "./spec";
import { Services } from "./store";

export class ServiceComponents {
  private services: Services;
  constructor(
    private sql: Sql,
    secret: string,
  ) {
    this.services = new Services(sql, secret);
  }
  private async read(id: unknown, name: string) {
    const row = await this.services.get(id);
    const config = await this.services.secrets.open<ServiceSpec>(
      row.id,
      row.config,
    );
    const component =
      config.catalog &&
      template(config.catalog.template, config.catalog.version).components.find(
        (c) => c.id === name,
      );
    if (!component) throw new AuthError("COMPONENT_NOT_FOUND", 404);
    return { row, config, component, revision: await hash(row.config) };
  }
  async variables(id: unknown, name: string) {
    const { component, revision } = await this.read(id, name);
    return {
      revision,
      variables: Object.entries(component.environment)
        .map(([name, value]) => ({
          name,
          references: [...value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map(
            (m) => m[1],
          ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  async reveal(id: unknown, name: string, body: unknown) {
    const { row, config, component, revision } = await this.read(id, name);
    const b = object(body);
    if (b.revision !== revision) throw new AuthError("VARIABLES_CHANGED", 409);
    if (
      typeof b.name !== "string" ||
      !Object.hasOwn(component.environment, b.name)
    )
      throw new AuthError("VARIABLE_NOT_FOUND", 404);
    let value = (component.environment as Record<string, string>)[
      b.name
    ] as string;
    for (const [key, secret] of Object.entries(config.environment))
      value = value.replaceAll(`\${${key}}`, secret);
    await new AuthStore(this.sql).audit(
      "service.component_variables_revealed",
      row.id,
    );
    return { value };
  }
  async metrics(id: unknown, name: string, range: string) {
    const { row } = await this.read(id, name);
    return metricsHistory(this.sql, row.id, range, Date.now(), name);
  }
}
