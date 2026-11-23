import { type CatalogSpec, template } from "./catalog";

// Presentation metadata is versioned separately: deployed recipe hashes must stay immutable.
const dependencies: Record<
  string,
  { from: string; to: string; variables: string[] }[]
> = {
  "umami:1": [{ from: "web", to: "database", variables: ["DATABASE_URL"] }],
  "wordpress:1": [
    {
      from: "web",
      to: "database",
      variables: ["WORDPRESS_DB_HOST", "WORDPRESS_DB_PASSWORD"],
    },
  ],
};
export function topology(spec: CatalogSpec) {
  const recipe = template(spec.template, spec.version);
  return {
    // Matches the worker's main endpoint; do not infer this from names or edges.
    primary: recipe.components.at(-1)?.id ?? "",
    web: recipe.web,
    components: recipe.components.map((c) => ({
      name: c.id,
      image: c.image,
      port: c.port,
      internal: c.internal,
      memoryMb: spec.resources?.memoryMb ?? c.memoryMb,
      cpus: spec.resources?.cpus ?? c.cpus,
      volumes: c.volumes.map((v) => v.target),
    })),
    dependencies: dependencies[`${recipe.id}:${recipe.version}`] ?? [],
  };
}
export type ServiceTopology = ReturnType<typeof topology>;
