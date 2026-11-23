import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  ReleaseSource,
  type SignedRelease,
  verifyRelease,
} from "../packages/api/src/panel/release/manifest";
import { Providers } from "../packages/api/src/panel/release/providers";
import type {
  Hosting,
  ReleaseJob,
} from "../packages/api/src/panel/release/types";
import { ServiceSecrets } from "../packages/api/src/services/crypto";

const source = new ReleaseSource(),
  providers = new Providers();
const directory = "/var/lib/ephor";
function secretHex(bytes: number, distinct: number) {
  for (;;) {
    const value = randomBytes(bytes).toString("hex");
    if (new Set(value).size >= distinct) return value;
  }
}
function run(command: string, args: string[], cwd = directory): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`${command} failed (${c})`)),
    );
  });
}
function origin(value: string) {
  const u = new URL(value);
  if (u.origin !== value || u.protocol !== "https:")
    throw new Error("Enter an HTTPS origin without a trailing slash.");
  return value;
}
async function atomic(path: string, text: string) {
  await writeFile(`${path}.tmp`, text, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
function compose(image: string, databaseVolume?: string) {
  return `services:
  database:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ephor
      POSTGRES_DB: ephor
      POSTGRES_PASSWORD: \${EPHOR_DB_PASSWORD}
    volumes: ["database:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ephor"]
      interval: 5s
      timeout: 5s
      retries: 30
  panel:
    image: ${image}
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://ephor:\${EPHOR_DB_PASSWORD}@database:5432/ephor
      EPHOR_ORIGIN: \${EPHOR_ORIGIN}
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET}
      EPHOR_SETUP_CODE: \${EPHOR_SETUP_CODE}
      EPHOR_PANEL_UPDATER_TOKEN: \${EPHOR_PANEL_UPDATER_TOKEN}
    ports: ["127.0.0.1:3002:3002"]
    volumes: ["./data:/data"]
    depends_on:
      database:
        condition: service_healthy
    read_only: true
    tmpfs: [/tmp]
    security_opt: ["no-new-privileges:true"]
volumes:
  database:
${databaseVolume ? `    external: true\n    name: ${databaseVolume}\n` : ""}`;
}
async function dockerPoll() {
  if (process.getuid?.() !== 0)
    throw new Error("Run the Docker updater as root.");
  const lockPath = `${directory}/updater.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (age < 3600_000) return;
    throw new Error(
      "Stale updater lock. Inspect the previous process before removing /var/lib/ephor/updater.lock.",
    );
  }
  try {
    const config = JSON.parse(
      await readFile(`${directory}/updater.json`, "utf8"),
    );
    const poll = async (body: unknown) => {
      const response = await fetch(
        "http://127.0.0.1:3002/api/panel-updater/poll",
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok)
        throw new Error(
          `Panel updater authentication failed (${response.status}).`,
        );
      return response.json() as Promise<{
        id: string;
        stage: string;
        envelope: SignedRelease;
      } | null>;
    };
    const job = await poll({});
    if (!job) return;
    // Both the unprivileged panel and privileged updater verify the signed envelope.
    const release = await verifyRelease(job.envelope);
    let ledger: { sequence: number; job?: string; phase?: string } = JSON.parse(
      await readFile(`${directory}/installed.json`, "utf8"),
    );
    if (
      release.sequence < ledger.sequence ||
      release.minimumSequence > ledger.sequence ||
      (release.sequence === ledger.sequence &&
        ledger.phase === "deployed" &&
        ledger.job !== job.id)
    )
      throw new Error("Refusing an old release.");
    if (job.stage === "verifying" && ledger.job !== job.id)
      throw new Error("Unexpected deployment state; inspect before retrying.");
    if (ledger.job === job.id && ledger.phase === "deployed") return;
    try {
      await run("docker", ["pull", release.image]);
      const installer = await source.artifact(release, release.installer);
      await atomic(
        `${directory}/installed.json`,
        JSON.stringify({
          sequence: release.sequence,
          job: job.id,
          phase: "prepared",
        }),
      );
      await poll({ id: job.id, stage: "verifying" });
      await atomic(
        `${directory}/compose.yaml`,
        compose(release.image, config.databaseVolume),
      );
      await run("docker", [
        "compose",
        "--project-name",
        "ephor",
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "300",
        "panel",
      ]);
      for (let i = 0; i < 60; i++) {
        const health = (await fetch("http://127.0.0.1:3002/health", {
          signal: AbortSignal.timeout(3000),
        })
          .then((r) => r.json())
          .catch(() => null)) as { version?: string } | null;
        if (health?.version === release.version) {
          await atomic(
            `${directory}/installer.mjs`,
            new TextDecoder().decode(installer),
          );
          ledger = {
            sequence: release.sequence,
            job: job.id,
            phase: "deployed",
          };
          await atomic(`${directory}/installed.json`, JSON.stringify(ledger));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error(
        "The new panel did not become healthy. Database backups are in /var/lib/ephor/data/backups.",
      );
    } catch (error) {
      await poll({ id: job.id, stage: "failed" }).catch(() => {});
      throw error;
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
async function main() {
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
    const envelope = await source.latest(),
      release = await verifyRelease(envelope);
    console.info(
      `Verified Ephor ${release.version}. No repository or build is required.`,
    );
    let secret = secretHex(48, 16);
    const setup = secretHex(24, 12);
    if (!process.argv.includes("--adopt"))
      console.info(
        `Save these in your password manager before continuing.\nOne-use setup code: ${setup}\nAuthentication secret: ${secret}`,
      );
    if (host === "docker") {
      if (process.platform !== "linux" || process.getuid?.() !== 0)
        throw new Error(
          "Docker installation requires a Linux host and root. Run with sudo.",
        );
      const adopting = process.argv.includes("--adopt");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let previous: Record<string, string> = {};
      try {
        const text = await readFile(`${directory}/.env`, "utf8");
        if (!adopting)
          throw new Error(
            "An installation already exists. Use its Updates page, or --adopt for a source installation.",
          );
        previous = Object.fromEntries(
          text
            .split("\n")
            .filter((l) => /^[A-Z_]+=/.test(l))
            .map((l) => {
              const i = l.indexOf("=");
              return [l.slice(0, i), l.slice(i + 1)];
            }),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        if (adopting)
          throw new Error(
            "First copy your existing private environment to /var/lib/ephor/.env; see the adoption guide.",
          );
      }
      const url = origin(
        previous.EPHOR_ORIGIN || (await ask("Public panel HTTPS origin")),
      );
      const token = randomBytes(32).toString("hex"),
        db = previous.EPHOR_DB_PASSWORD || randomBytes(32).toString("hex");
      if (adopting) secret = previous.BETTER_AUTH_SECRET || "";
      if (
        !/^[a-f0-9]{32,128}$/i.test(db) ||
        !/^[a-f0-9]{64,128}$/i.test(secret)
      )
        throw new Error(
          "Managed Docker installs require the existing secret and database password in hexadecimal form. Do not regenerate a secret for an existing installation; see manual migration guidance.",
        );
      let databaseVolume: string | undefined;
      if (adopting) {
        databaseVolume = await ask("Existing PostgreSQL 17 Docker volume name");
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(databaseVolume))
          throw new Error("Invalid volume name");
        await run("docker", [
          "volume",
          "inspect",
          "--format",
          "{{.Name}}",
          databaseVolume,
        ]);
        const child = spawn(
          "docker",
          ["ps", "--filter", `volume=${databaseVolume}`, "--format", "{{.ID}}"],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once("close", resolve);
          child.once("error", reject);
        });
        let used = "";
        for await (const part of child.stdout) used += part.toString();
        const code = await closed;
        if (code !== 0 || used.trim())
          throw new Error(
            "Stop the existing panel and database containers first. Never mount a database volume in two database servers.",
          );
      }
      await mkdir(`${directory}/data`, { recursive: true, mode: 0o700 });
      await atomic(
        `${directory}/.env`,
        `EPHOR_ORIGIN=${url}\nEPHOR_DB_PASSWORD=${db}\nBETTER_AUTH_SECRET=${secret}\nEPHOR_SETUP_CODE=${setup}\nEPHOR_PANEL_UPDATER_TOKEN=${token}\n`,
      );
      await atomic(
        `${directory}/updater.json`,
        JSON.stringify({ token, databaseVolume }),
      );
      await atomic(
        `${directory}/installed.json`,
        JSON.stringify({ sequence: release.sequence }),
      );
      await atomic(
        `${directory}/compose.yaml`,
        compose(release.image, databaseVolume),
      );
      await atomic(
        `${directory}/installer.mjs`,
        new TextDecoder().decode(
          await source.artifact(release, release.installer),
        ),
      );
      const node = process.execPath;
      if (!/^\/[a-zA-Z0-9_./-]+$/.test(node))
        throw new Error(
          "Node executable path contains unsupported characters.",
        );
      await writeFile(
        "/etc/systemd/system/ephor-updater.service",
        `[Unit]\nDescription=Ephor release updater\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nWorkingDirectory=${directory}\nExecStart=${node} ${directory}/installer.mjs --docker-poll\nUMask=0077\nTimeoutStartSec=1800\n`,
        { mode: 0o644 },
      );
      await writeFile(
        "/etc/systemd/system/ephor-updater.timer",
        "[Unit]\nDescription=Check for approved Ephor panel updates\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=30s\n[Install]\nWantedBy=timers.target\n",
        { mode: 0o644 },
      );
      await run("docker", [
        "compose",
        "--project-name",
        "ephor",
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "300",
      ]);
      await run("systemctl", ["daemon-reload"]);
      await run("systemctl", ["enable", "--now", "ephor-updater.timer"]);
      console.info(
        `Point your HTTPS reverse proxy at 127.0.0.1:3002, then open ${url}.`,
      );
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
      const token = process.env.RAILWAY_PROJECT_TOKEN;
      if (!token)
        throw new Error(
          "Set RAILWAY_PROJECT_TOKEN to a project token for the target environment.",
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
        EPHOR_RAILWAY_PROJECT_TOKEN: token,
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
