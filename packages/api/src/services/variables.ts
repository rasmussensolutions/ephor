import { AuthError, AuthStore, hash, type Sql } from "../auth/store";
import { connectionReference, ServiceConnections } from "./connections";
import { MAX_ENVIRONMENT_VARIABLES } from "./environment";
import { object, type ServiceSpec, spec } from "./spec";
import { Services } from "./store";

/** Variables never travel with ordinary service reads. Writes compare the
 * encrypted configuration so simultaneous edits cannot overwrite each other. */
export class ServiceVariables {
  private services: Services;
  constructor(
    private sql: Sql,
    secret: string,
  ) {
    this.services = new Services(sql, secret);
  }
  private async read(id: unknown) {
    const row = await this.services.get(id);
    const config = await this.services.secrets.open<ServiceSpec>(
      row.id,
      row.config,
    );
    return { row, config, revision: await hash(row.config) };
  }
  async list(id: unknown) {
    const { row, config, revision } = await this.read(id);
    const suggestions = config.catalog
      ? []
      : await new ServiceConnections(
          this.sql,
          this.services.secrets,
        ).suggestions(row);
    return {
      names: Object.keys(config.environment).sort(),
      revision,
      editable: !config.catalog,
      suggestions,
      references: Object.fromEntries(
        Object.entries(config.environment).flatMap(([name, value]) => {
          const ref = connectionReference(value);
          return ref ? [[name, { ...ref, value }]] : [];
        }),
      ),
    };
  }
  async reveal(id: unknown, body: unknown) {
    const { row, config, revision } = await this.read(id);
    const b = object(body);
    if (b.revision !== revision) throw new AuthError("VARIABLES_CHANGED", 409);
    if (
      b.name !== undefined &&
      (typeof b.name !== "string" || !Object.hasOwn(config.environment, b.name))
    )
      throw new AuthError("VARIABLE_NOT_FOUND", 404);
    await new AuthStore(this.sql).audit("service.variables_revealed", row.id);
    return {
      values:
        b.name === undefined
          ? config.environment
          : { [String(b.name)]: config.environment[String(b.name)] },
    };
  }
  async update(id: unknown, body: unknown) {
    const { row, config, revision } = await this.read(id);
    if (config.catalog) throw new AuthError("CATALOG_CONFIG_LOCKED", 409);
    const b = object(body);
    if (b.revision !== revision) throw new AuthError("VARIABLES_CHANGED", 409);
    const set = object(b.set ?? {});
    const remove = b.remove ?? [];
    if (
      !Array.isArray(remove) ||
      remove.length > MAX_ENVIRONMENT_VARIABLES ||
      remove.some(
        (name) =>
          typeof name !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name),
      )
    )
      throw new AuthError("INVALID_ENVIRONMENT");
    const environment = { ...config.environment };
    for (const name of remove) delete environment[name];
    const updated = spec({
      ...config,
      environment: { ...environment, ...set },
    });
    await new ServiceConnections(this.sql, this.services.secrets).resolve(
      row,
      updated,
    );
    const encrypted = await this.services.secrets.seal(row.id, updated);
    const changed = await this.sql.query(
      "UPDATE ephor_service SET config=$1 WHERE id=$2 AND config=$3 RETURNING id",
      [encrypted, row.id, row.config],
    );
    if (!changed.length) throw new AuthError("VARIABLES_CHANGED", 409);
    await new AuthStore(this.sql).audit("service.variables_updated", row.id);
    return this.list(row.id);
  }
}
