import {
  imageTechnology,
  type ServiceSource,
  type ServiceTechnology,
} from "@ephor/api/services";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import {
  siAdonisjs,
  siAngular,
  siApachekafka,
  siAstro,
  siBun,
  siCaddy,
  siDeno,
  siDirectus,
  siDjango,
  siDotnet,
  siElixir,
  siExpress,
  siFastapi,
  siFastify,
  siFlask,
  siGitea,
  siGithub,
  siGo,
  siGrafana,
  siHomeassistant,
  siHono,
  siHugo,
  siJekyll,
  siJellyfin,
  siLaravel,
  siMariadb,
  siMinio,
  siMongodb,
  siMysql,
  siN8n,
  siNestjs,
  siNextdotjs,
  siNginx,
  siNodedotjs,
  siNuxt,
  siOllama,
  siOpenjdk,
  siPhoenixframework,
  siPhp,
  siPlex,
  siPostgresql,
  siPrometheus,
  siPython,
  siQwik,
  siRabbitmq,
  siReact,
  siReactrouter,
  siRedis,
  siRemix,
  siRuby,
  siRubyonrails,
  siRust,
  siSolid,
  siSpringboot,
  siSvelte,
  siTanstack,
  siTraefikproxy,
  siUmami,
  siUptimekuma,
  siVaultwarden,
  siVite,
  siVuedotjs,
  siWordpress,
} from "simple-icons";

const brands = {
  adonis: siAdonisjs,
  angular: siAngular,
  astro: siAstro,
  bun: siBun,
  caddy: siCaddy,
  deno: siDeno,
  directus: siDirectus,
  django: siDjango,
  dotnet: siDotnet,
  elixir: siElixir,
  express: siExpress,
  fastapi: siFastapi,
  fastify: siFastify,
  flask: siFlask,
  gitea: siGitea,
  go: siGo,
  grafana: siGrafana,
  homeassistant: siHomeassistant,
  hono: siHono,
  hugo: siHugo,
  java: siOpenjdk,
  jekyll: siJekyll,
  jellyfin: siJellyfin,
  kafka: siApachekafka,
  laravel: siLaravel,
  mariadb: siMariadb,
  minio: siMinio,
  mongodb: siMongodb,
  mysql: siMysql,
  n8n: siN8n,
  nestjs: siNestjs,
  next: siNextdotjs,
  nginx: siNginx,
  node: siNodedotjs,
  nuxt: siNuxt,
  ollama: siOllama,
  phoenix: siPhoenixframework,
  php: siPhp,
  plex: siPlex,
  postgres: siPostgresql,
  prometheus: siPrometheus,
  python: siPython,
  qwik: siQwik,
  rabbitmq: siRabbitmq,
  rails: siRubyonrails,
  react: siReact,
  reactrouter: siReactrouter,
  redis: siRedis,
  remix: siRemix,
  ruby: siRuby,
  rust: siRust,
  solid: siSolid,
  spring: siSpringboot,
  svelte: siSvelte,
  tanstack: siTanstack,
  traefik: siTraefikproxy,
  umami: siUmami,
  uptimekuma: siUptimekuma,
  vaultwarden: siVaultwarden,
  vite: siVite,
  vue: siVuedotjs,
  wordpress: siWordpress,
} satisfies Record<ServiceTechnology, typeof siGithub>;

export function ServiceIcon({
  source,
  image,
  size,
}: {
  source: ServiceSource;
  image: string;
  size: number;
}) {
  const technology =
    source.type === "github" || source.type === "catalog"
      ? (source.technology ?? imageTechnology(image))
      : imageTechnology(image);
  const brand =
    technology && Object.hasOwn(brands, technology)
      ? brands[technology]
      : source.type === "github"
        ? siGithub
        : null;

  if (!brand) return <CubeIcon size={size} aria-hidden="true" />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={brand.title}
      className="shrink-0 fill-current text-foreground"
    >
      <title>{brand.title}</title>
      <path d={brand.path} />
    </svg>
  );
}
