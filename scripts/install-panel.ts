import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  ReleaseSource,
  verifyRelease,
} from "../packages/api/src/panel/release/manifest";
import { Providers } from "../packages/api/src/panel/release/providers";
import type {
  Hosting,
  ReleaseJob,
} from "../packages/api/src/panel/release/types";
import { PANEL_VERSION } from "../packages/api/src/panel/release/version";
import { ServiceSecrets } from "../packages/api/src/services/crypto";
import { dockerPoll, installVps } from "./panel-vps";

const source = new ReleaseSource(),
  providers = new Providers();
function secretHex(bytes: number, distinct: number) {
  for (;;) {
    const value = randomBytes(bytes).toString("hex");
    if (new Set(value).size >= distinct) return value;
  }
}
function origin(value: string) {
  const u = new URL(value);
  if (u.origin !== value || u.protocol !== "https:")
    throw new Error("Enter an HTTPS origin without a trailing slash.");
  return value;
}
async function main() {
  if (process.argv.includes("--version")) {
    console.info(PANEL_VERSION);
    return;
  }
  if (process.argv.includes("--docker-poll")) {
    await dockerPoll();
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (label: string, fallback = "") =>
    (
      await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)
    ).trim() || fallback;
  try {
    const host =
      process.argv[2] || (await ask("Hosting: docker, cloudflare, or railway"));
    const releaseFile = process.argv
      .find((a) => a.startsWith("--release-file="))
      ?.slice(15);
    const envelope = releaseFile
        ? JSON.parse(await readFile(releaseFile, "utf8"))
        : await source.latest(),
      release = await verifyRelease(envelope);
    console.info(
      `Verified Ephor ${release.version}. No repository or build is required.`,
    );
    const secret = secretHex(48, 16);
    const setup = secretHex(24, 12);
    if (!["docker", "vps"].includes(host) && !process.argv.includes("--adopt"))
      console.info(
        `Save these in your password manager before continuing.\nOne-use setup code: ${setup}\nAuthentication secret: ${secret}`,
      );
    if (host === "docker" || host === "vps") {
      const domain = process.argv
        .find((a) => a.startsWith("--domain="))
        ?.slice(9);
      await installVps(envelope, {
        domain,
        externalProxy: process.argv.includes("--external-proxy"),
        adopt: process.argv.includes("--adopt"),
        ask,
      });
      return;
    } else if (host === "cloudflare") {
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!token)
        throw new Error(
          "Set CLOUDFLARE_API_TOKEN (Workers Scripts Edit and D1 Edit on the chosen account). The token is never echoed.",
        );
      const accountId = await ask(
          "Cloudflare account ID",
          process.env.CLOUDFLARE_ACCOUNT_ID,
        ),
        worker = await ask("New Worker name", "ephor");
      if (
        !/^[a-f0-9]{32}$/.test(accountId) ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(worker)
      )
        throw new Error("Invalid Cloudflare target.");
      const h: Extract<Hosting, { host: "cloudflare" }> = {
        host: "cloudflare",
        token,
        accountId,
        worker,
        databaseId: "",
      };
      const subdomain = await providers.cf<{ subdomain: string }>(
        h,
        "/workers/subdomain",
      );
      const url = origin(
        await ask(
          "Panel HTTPS origin",
          `https://${worker}.${subdomain.subdomain}.workers.dev`,
        ),
      );
      const adopting = process.argv.includes("--adopt");
      let existing:
        | {
            bindings: {
              name: string;
              type: string;
              id?: string;
              text?: string;
            }[];
          }
        | undefined;
      try {
        existing = await providers.cf(h, `/workers/scripts/${worker}/settings`);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "CLOUDFLARE_HTTP_404")
          throw e;
      }
      if (existing && !adopting)
        throw new Error(
          "Worker already exists. Use --adopt to preserve its database and secrets.",
        );
      if (adopting && !existing)
        throw new Error("Cannot adopt a Worker that does not exist.");
      if (existing) {
        const db = existing.bindings.find(
          (b) => b.name === "DB" && b.type === "d1",
        );
        if (
          !db?.id ||
          !existing.bindings.some(
            (b) => b.name === "EPHOR_ORIGIN" && b.text === url,
          )
        )
          throw new Error("Worker origin or D1 binding does not match.");
        h.databaseId = db.id;
        console.info(
          "Disable the Worker's Git build trigger in Cloudflare before continuing; otherwise a source push can overwrite a release.",
        );
        if ((await ask("Type ADOPT after disabling that trigger")) !== "ADOPT")
          throw new Error("Adoption cancelled.");
      } else {
        const db = await providers.cf<{ uuid: string }>(
          h,
          "/d1/database",
          "POST",
          { name: `${worker}-database` },
        );
        h.databaseId = db.uuid;
        console.info(
          `Created D1 database ${db.uuid}. Keep this ID if installation is interrupted.`,
        );
        const bootstrap = new FormData();
        bootstrap.append(
          "metadata",
          JSON.stringify({
            main_module: "worker.mjs",
            compatibility_date: release.compatibilityDate,
            bindings: [
              { name: "DB", type: "d1", id: db.uuid },
              { name: "EPHOR_ORIGIN", type: "plain_text", text: url },
              { name: "BETTER_AUTH_SECRET", type: "secret_text", text: secret },
              { name: "EPHOR_SETUP_CODE", type: "secret_text", text: setup },
            ],
          }),
        );
        bootstrap.append(
          "worker.mjs",
          new Blob(
            [
              'export default {fetch(){return new Response("Ephor is installing",{status:503})}}',
            ],
            { type: "application/javascript+module" },
          ),
          "worker.mjs",
        );
        await providers.cf(h, `/workers/scripts/${worker}`, "PUT", bootstrap);
      }
      // Add ASSETS to the initial binding set; final deployment supplies its upload token.
      const job: ReleaseJob = {
        id: crypto.randomUUID(),
        version: release.version,
        sequence: release.sequence,
        envelope,
        stage: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        message: "Installing",
      };
      while (job.stage !== "verifying") {
        await providers.cloudflareStep(h, release, job, async () => {});
      }
      if (!adopting) {
        const sealed = await new ServiceSecrets(secret).seal("panel-releases", {
          hosting: h,
          highestSequence: release.sequence,
        });
        await providers.cf(h, `/d1/database/${h.databaseId}/query`, "POST", {
          sql: "UPDATE ephor_panel_release SET payload=? WHERE id=1",
          params: [sealed],
        });
      } else
        console.info(
          "Your owner and secrets are preserved. Connect this token once under Updates → Hosting setup.",
        );
      await providers.cf(h, `/workers/scripts/${worker}/schedules`, "PUT", [
        { cron: "* * * * *" },
      ]);
      if (!adopting)
        await providers.cf(h, `/workers/scripts/${worker}/subdomain`, "POST", {
          enabled: true,
          previews_enabled: false,
        });
      console.info(
        `Open ${url}. If using a custom domain, attach it in Cloudflare first.`,
      );
    } else if (host === "railway") {
      const token = process.env.RAILWAY_API_TOKEN;
      if (!token)
        throw new Error(
          "Set RAILWAY_API_TOKEN to a workspace-scoped API token for the target project.",
        );
      const projectId = await ask("Railway project ID"),
        environmentId = await ask("Railway environment ID");
      const validId = /^[a-f0-9-]{36}$/i;
      if (!validId.test(projectId) || !validId.test(environmentId))
        throw new Error("Invalid Railway target.");
      const h: Extract<Hosting, { host: "railway" }> = {
        host: "railway",
        token,
        environmentId,
        serviceId: "",
      };
      const dbPassword = randomBytes(32).toString("hex");
      const create = async (
        name: string,
        image: string,
        variables: Record<string, string>,
      ) => {
        const r = await providers.railway<{ serviceCreate: { id: string } }>(
          h,
          "mutation($input:ServiceCreateInput!){serviceCreate(input:$input){id}}",
          {
            input: {
              projectId,
              environmentId,
              name,
              source: { image },
              variables,
            },
          },
        );
        console.info(
          `Created ${name}: ${r.serviceCreate.id}. Keep this ID if installation is interrupted.`,
        );
        return r.serviceCreate.id;
      };
      const volume = async (serviceId: string, mountPath: string) =>
        providers.railway(
          h,
          "mutation($input:VolumeCreateInput!){volumeCreate(input:$input){id}}",
          { input: { projectId, environmentId, serviceId, mountPath } },
        );
      const databaseId = await create("ephor-database", "postgres:17-alpine", {
        POSTGRES_USER: "ephor",
        POSTGRES_DB: "ephor",
        POSTGRES_PASSWORD: dbPassword,
        PGDATA: "/var/lib/postgresql/data/pgdata",
      });
      await volume(databaseId, "/var/lib/postgresql/data");
      await providers.railway(
        { ...h, serviceId: databaseId },
        "mutation($serviceId:String!,$environmentId:String!){serviceInstanceDeployV2(serviceId:$serviceId,environmentId:$environmentId)}",
      );
      h.serviceId = await create("ephor", release.image, {
        DATABASE_URL: `postgresql://ephor:${dbPassword}@ephor-database.railway.internal:5432/ephor`,
        BETTER_AUTH_SECRET: secret,
        EPHOR_SETUP_CODE: setup,
        EPHOR_RAILWAY_API_TOKEN: token,
        PORT: "3002",
      });
      await volume(h.serviceId, "/data");
      const domain = await providers.railway<{
        serviceDomainCreate: { domain: string };
      }>(
        h,
        "mutation($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){domain}}",
        { input: { serviceId: h.serviceId, environmentId, targetPort: 3002 } },
      );
      const url = origin(`https://${domain.serviceDomainCreate.domain}`);
      await providers.railway(
        h,
        "mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}",
        {
          input: {
            projectId,
            environmentId,
            serviceId: h.serviceId,
            skipDeploys: true,
            variables: { EPHOR_ORIGIN: url },
          },
        },
      );
      const job: ReleaseJob = {
        id: crypto.randomUUID(),
        version: release.version,
        sequence: release.sequence,
        envelope,
        stage: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        message: "Installing",
      };
      await providers.railwayDeploy(h, release, job, async () => {});
      console.info(
        `Railway deployment started. Open ${url} once its health check passes. Updates are connected automatically.`,
      );
    } else throw new Error("Choose docker, cloudflare, or railway.");
    if (!process.argv.includes("--adopt"))
      console.info(
        `One-use setup code: ${setup}\nSave your authentication secret securely: ${secret}`,
      );
  } finally {
    rl.close();
  }
}
if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : "Installation failed");
    process.exitCode = 1;
  });
