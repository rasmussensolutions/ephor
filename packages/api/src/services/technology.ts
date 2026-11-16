const imageTechnologies = {
  "docker.io/louislam/uptime-kuma": "uptimekuma",
  "docker.io/library/node": "node",
  "docker.io/library/python": "python",
  "docker.io/library/golang": "go",
  "docker.io/library/rust": "rust",
  "docker.io/library/ruby": "ruby",
  "docker.io/library/php": "php",
  "docker.io/oven/bun": "bun",
  "docker.io/denoland/deno": "deno",
  "docker.io/library/postgres": "postgres",
  "docker.io/library/mysql": "mysql",
  "docker.io/library/mariadb": "mariadb",
  "docker.io/library/mongo": "mongodb",
  "docker.io/library/redis": "redis",
  "docker.io/library/rabbitmq": "rabbitmq",
  "docker.io/apache/kafka": "kafka",
  "docker.io/library/nginx": "nginx",
  "docker.io/library/caddy": "caddy",
  "docker.io/library/traefik": "traefik",
  "docker.io/library/wordpress": "wordpress",
  "docker.io/grafana/grafana": "grafana",
  "docker.io/prom/prometheus": "prometheus",
  "quay.io/prometheus/prometheus": "prometheus",
  "docker.io/minio/minio": "minio",
  "quay.io/minio/minio": "minio",
  "docker.io/gitea/gitea": "gitea",
  "docker.gitea.com/gitea": "gitea",
  "docker.io/jellyfin/jellyfin": "jellyfin",
  "docker.io/plexinc/pms-docker": "plex",
  "docker.io/ollama/ollama": "ollama",
  "docker.io/homeassistant/home-assistant": "homeassistant",
  "ghcr.io/home-assistant/home-assistant": "homeassistant",
  "docker.io/n8nio/n8n": "n8n",
  "docker.n8n.io/n8nio/n8n": "n8n",
  "docker.io/directus/directus": "directus",
  "ghcr.io/umami-software/umami": "umami",
  "docker.io/vaultwarden/server": "vaultwarden",
  "ghcr.io/dani-garcia/vaultwarden": "vaultwarden",
} as const;

const jsFrameworks = [
  [
    "tanstack",
    ["@tanstack/react-start", "@tanstack/solid-start", "@tanstack/start"],
  ],
  ["next", ["next"]],
  ["nuxt", ["nuxt", "nuxt3"]],
  [
    "tanstack",
    [
      "@tanstack/react-router",
      "@tanstack/solid-router",
      "@tanstack/vue-router",
    ],
  ],
  ["astro", ["astro"]],
  ["svelte", ["@sveltejs/kit", "svelte"]],
  ["remix", ["@remix-run/react", "@remix-run/node"]],
  ["reactrouter", ["@react-router/dev", "@react-router/node"]],
  ["angular", ["@angular/core"]],
  ["qwik", ["@builder.io/qwik"]],
  ["nestjs", ["@nestjs/core"]],
  ["adonis", ["@adonisjs/core"]],
  ["solid", ["solid-js"]],
  ["vue", ["vue"]],
  ["react", ["react", "react-dom"]],
  ["hono", ["hono"]],
  ["fastify", ["fastify"]],
  ["express", ["express"]],
  ["vite", ["vite"]],
] as const;

export type ServiceTechnology =
  | (typeof imageTechnologies)[keyof typeof imageTechnologies]
  | (typeof jsFrameworks)[number][0]
  | "django"
  | "fastapi"
  | "flask"
  | "laravel"
  | "rails"
  | "elixir"
  | "phoenix"
  | "dotnet"
  | "spring"
  | "java"
  | "hugo"
  | "jekyll";

export function imageTechnology(image: string): ServiceTechnology | undefined {
  const name = image.replace(/(?:@sha256:[a-f0-9]+|:[^/:]+)$/, "");
  const parts = name.split("/");
  if (parts[0] === "index.docker.io" || parts[0] === "registry-1.docker.io")
    parts[0] = "docker.io";
  if (parts[0] === "docker.io" && parts.length === 2)
    parts.splice(1, 0, "library");
  const key = parts.join("/");
  return Object.hasOwn(imageTechnologies, key)
    ? imageTechnologies[key as keyof typeof imageTechnologies]
    : undefined;
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Inspect only the chosen build context. Framework packages outrank generic runtimes.
export async function detectTechnology(
  names: ReadonlySet<string>,
  read: (name: string) => Promise<string | null>,
): Promise<ServiceTechnology | null> {
  const manifest = names.has("package.json")
    ? await read("package.json")
    : null;
  let js = false;
  if (manifest) {
    try {
      const parsed: unknown = JSON.parse(manifest);
      const pkg = fields(parsed);
      js = parsed === pkg;
      const deps = new Set([
        ...Object.keys(fields(pkg.dependencies)),
        ...Object.keys(fields(pkg.devDependencies)),
        ...Object.keys(fields(pkg.optionalDependencies)),
      ]);
      const framework = jsFrameworks.find(([, packages]) =>
        packages.some((name) => deps.has(name)),
      );
      if (framework) return framework[0];
      if (
        typeof pkg.packageManager === "string" &&
        pkg.packageManager.startsWith("bun@")
      )
        return "bun";
    } catch {
      // An invalid manifest is not a technology signal.
    }
  }

  if (
    names.has("deno.json") ||
    names.has("deno.jsonc") ||
    names.has("deno.lock")
  )
    return "deno";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (names.has("manage.py")) return "django";

  const pythonFiles = ["pyproject.toml", "requirements.txt", "Pipfile"].filter(
    (name) => names.has(name),
  );
  if (pythonFiles.length) {
    const requirements = (await Promise.all(pythonFiles.map(read))).join("\n");
    const match = (name: string) =>
      new RegExp(`(?:^|[\\s"'])${name}(?=[\\s"'[<>=!~;]|$)`, "im").test(
        requirements,
      );
    if (match("fastapi")) return "fastapi";
    if (match("django")) return "django";
    if (match("flask")) return "flask";
    return "python";
  }
  if (names.has("composer.json")) {
    const composer = await read("composer.json");
    try {
      if (
        composer &&
        Object.hasOwn(
          fields(fields(JSON.parse(composer)).require),
          "laravel/framework",
        )
      )
        return "laravel";
    } catch {
      // A malformed manifest still identifies the package ecosystem.
    }
    return "php";
  }
  if (names.has("Gemfile")) {
    const gems = await read("Gemfile");
    if (gems && /^\s*gem\s+["']rails["']/m.test(gems)) return "rails";
    if (gems && /^\s*gem\s+["']jekyll["']/m.test(gems)) return "jekyll";
    return "ruby";
  }
  if (names.has("mix.exs"))
    return /\{:phoenix\s*,/.test((await read("mix.exs")) ?? "")
      ? "phoenix"
      : "elixir";
  if (names.has("Cargo.toml")) return "rust";
  if (names.has("go.mod")) return "go";
  if (
    [...names].some((name) => /\.(?:csproj|fsproj|vbproj|sln|slnx)$/.test(name))
  )
    return "dotnet";
  const javaFile = ["pom.xml", "build.gradle", "build.gradle.kts"].find(
    (name) => names.has(name),
  );
  if (javaFile)
    return /org\.springframework\.boot|spring-boot-starter/.test(
      (await read(javaFile)) ?? "",
    )
      ? "spring"
      : "java";
  if (["hugo.toml", "hugo.yaml", "hugo.json"].some((name) => names.has(name)))
    return "hugo";
  if (js || names.has(".nvmrc") || names.has(".node-version")) return "node";
  if (names.has("setup.py")) return "python";
  return null;
}
