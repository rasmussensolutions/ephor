import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import {
  type PanelRelease,
  ReleaseSource,
  type SignedRelease,
  verifyRelease,
} from "../packages/api/src/panel/release/manifest";

export const VPS_DIRECTORY = "/var/lib/ephor";
export const CADDY_IMAGE =
  "docker.io/library/caddy@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0";
const directory = VPS_DIRECTORY;
const source = new ReleaseSource();
export async function command(
  command: string,
  args: string[],
  capture = false,
  cwd = directory,
): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    env:
      command === "apt-get"
        ? { ...process.env, DEBIAN_FRONTEND: "noninteractive" }
        : process.env,
    stdio: [
      "ignore",
      capture ? "pipe" : "inherit",
      capture ? "pipe" : "inherit",
    ],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args[0] ?? ""} failed (${code}).`)),
    );
  });
  let output = "";
  if (child.stderr) child.stderr.resume();
  const consume = async () => {
    if (child.stdout)
      for await (const part of child.stdout) output += part.toString();
  };
  await Promise.all([closed, consume()]);
  return output.trim();
}
export async function atomic(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
) {
  await writeFile(`${path}.tmp`, data, { mode });
  await chmod(`${path}.tmp`, mode);
  await rename(`${path}.tmp`, path);
}
export function panelOrigin(value: string): string {
  const u = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)
  )
    throw new Error(
      "Enter a public domain such as panel.example.com, without a path or port.",
    );
  return u.origin;
}
export function caddyfile(origin: string) {
  return `${new URL(panelOrigin(origin)).hostname} {\n  encode zstd gzip\n  reverse_proxy panel:3002\n}\n`;
}
export function proxyCompose(image: string) {
  if (!/^docker\.io\/library\/caddy@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Untrusted HTTPS proxy image");
  return `services:
  https:
    image: ${image}
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "https-data:/data", "https-config:/config"]
    read_only: true
    tmpfs: [/tmp]
    security_opt: ["no-new-privileges:true"]
    depends_on: [panel]
volumes:
  https-data:
  https-config:
`;
}
export function compose(image: string, databaseVolume?: string) {
  if (
    !/^ghcr\.io\/rasmussensolutions\/ephor-panel@sha256:[a-f0-9]{64}$/.test(
      image,
    )
  )
    throw new Error("Untrusted panel image");
  if (
    databaseVolume &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(databaseVolume)
  )
    throw new Error("Invalid database volume");
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
async function availablePort(port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", (e: NodeJS.ErrnoException) =>
      e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL"
        ? resolve()
        : reject(
            new Error(
              `Port ${port} is already occupied. Keep the existing service and use --external-proxy, or free the port before retrying.`,
            ),
          ),
    );
    server.listen({ port, host, exclusive: true }, () =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
}
export async function ensureDocker() {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Run this installer with sudo on the Linux VPS.");
  await stat("/run/systemd/system").catch(() => {
    throw new Error("This installer needs a Linux server running systemd.");
  });
  let existing = false;
  try {
    await command("docker", ["--version"], true, "/");
    existing = true;
  } catch {
    /* A fresh server. */
  }
  if (!existing) {
    const os = Object.fromEntries(
      (await readFile("/etc/os-release", "utf8")).split("\n").map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, "")];
      }),
    );
    const releases: Record<string, string[]> = {
      ubuntu: ["22.04", "24.04", "26.04"],
      debian: ["12", "13"],
    };
    if (
      !releases[os.ID ?? ""]?.includes(os.VERSION_ID ?? "") ||
      !/^[a-z]+$/.test(os.VERSION_CODENAME ?? "")
    )
      throw new Error(
        "Automatic Docker setup supports Ubuntu 22.04/24.04/26.04 and Debian 12/13. On another system, install Docker Engine and Compose first.",
      );
    console.info(
      "Installing Docker Engine and Compose from Docker's signed package repository.",
    );
    await command("apt-get", ["update"], false, "/");
    await command(
      "apt-get",
      ["install", "-y", "ca-certificates", "curl"],
      false,
      "/",
    );
    await mkdir("/etc/apt/keyrings", { recursive: true, mode: 0o755 });
    const arch = await command("dpkg", ["--print-architecture"], true, "/");
    if (!["amd64", "arm64"].includes(arch))
      throw new Error("Use an x86-64 or ARM64 server.");
    // Do not replace an administrator's repository configuration.
    const repository = "/etc/apt/sources.list.d/ephor-docker.sources";
    const key = "/etc/apt/keyrings/ephor-docker.asc";
    const repositoryText = `Types: deb\nURIs: https://download.docker.com/linux/${os.ID}\nSuites: ${os.VERSION_CODENAME}\nComponents: stable\nArchitectures: ${arch}\nSigned-By: ${key}\n`;
    if (
      (await exists(repository)) &&
      (await readFile(repository, "utf8")) !== repositoryText
    )
      throw new Error(
        "The Ephor Docker repository configuration was customized; it will not be overwritten.",
      );
    await command(
      "curl",
      [
        "-fsSL",
        "--proto",
        "=https",
        `https://download.docker.com/linux/${os.ID}/gpg`,
        "-o",
        `${key}.tmp`,
      ],
      false,
      "/",
    );
    await chmod(`${key}.tmp`, 0o644);
    await rename(`${key}.tmp`, key);
    await atomic(
      repository,
      `Types: deb\nURIs: https://download.docker.com/linux/${os.ID}\nSuites: ${os.VERSION_CODENAME}\nComponents: stable\nArchitectures: ${arch}\nSigned-By: ${key}\n`,
      0o644,
    );
    await command("apt-get", ["update"], false, "/");
    await command(
      "apt-get",
      [
        "install",
        "-y",
        "docker-ce",
        "docker-ce-cli",
        "containerd.io",
        "docker-buildx-plugin",
        "docker-compose-plugin",
      ],
      false,
      "/",
    );
  }
  await command("systemctl", ["enable", "--now", "docker"], false, "/");
  await command("docker", ["info"], true, "/");
  try {
    await command("docker", ["compose", "version"], true, "/");
  } catch {
    // Add a plugin from an already trusted package source; never replace the engine.
    let plugin: string | undefined;
    for (const name of ["docker-compose-plugin", "docker-compose-v2"]) {
      const candidate = await command(
        "apt-cache",
        ["policy", name],
        true,
        "/",
      ).catch(() => "");
      if (/Candidate:\s+(?!\(none\))\S+/.test(candidate)) {
        plugin = name;
        break;
      }
    }
    if (!plugin)
      throw new Error(
        "The existing Docker installation has no Compose v2 plugin available from its trusted package sources. Install that plugin and rerun Ephor; the existing engine was preserved.",
      );
    await command(
      "apt-get",
      ["install", "-y", "--no-remove", plugin],
      false,
      "/",
    );
    await command("docker", ["compose", "version"], true, "/");
  }
}
async function checkDirectory() {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error(
        "/var/lib/ephor must be a real directory owned by root and not writable by other users.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
function newSecret(bytes: number) {
  for (;;) {
    const s = randomBytes(bytes).toString("hex");
    if (new Set(s).size === 16) return s;
  }
}
async function environment() {
  return Object.fromEntries(
    (await readFile(`${directory}/.env`, "utf8"))
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}
function nativeArtifact(r: PanelRelease) {
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new Error("Unsupported VPS architecture");
  const a = r.vps?.[process.arch];
  if (!a)
    throw new Error(
      "This release has no standalone VPS installer. Existing installations can keep their Node updater.",
    );
  return a;
}
async function installUpdater(r: PanelRelease, releases = source) {
  await atomic(
    `${directory}/ephor-installer`,
    await releases.artifact(r, nativeArtifact(r)),
    0o700,
  );
  await atomic(
    "/etc/systemd/system/ephor-updater.service",
    `[Unit]\nDescription=Ephor release updater\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nWorkingDirectory=${directory}\nExecStart=${directory}/ephor-installer --docker-poll\nUMask=0077\nTimeoutStartSec=1800\n`,
    0o644,
  );
  await atomic(
    "/etc/systemd/system/ephor-updater.timer",
    "[Unit]\nDescription=Check for approved Ephor panel updates\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=30s\n[Install]\nWantedBy=timers.target\n",
    0o644,
  );
  await command("systemctl", ["daemon-reload"]);
  await command("systemctl", ["enable", "--now", "ephor-updater.timer"]);
}
export async function healthy(url: string, version?: string, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${url}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const b = (await r.json()) as { version?: string };
      if (r.ok && (!version || b.version === version)) return;
    } catch {
      /* Startup and certificate issuance can take time. */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `The panel is not yet reachable at ${url}. Check DNS (including AAAA records), inbound ports 80/443 and 'sudo docker compose --project-directory ${directory} logs https panel', then rerun the same installer. Your settings and data are preserved.`,
  );
}
export interface VpsOptions {
  domain?: string;
  externalProxy?: boolean;
  adopt?: boolean;
  ask: (label: string, fallback?: string) => Promise<string>;
}
interface Installation {
  origin: string;
  managedHttps: boolean;
  envelope: SignedRelease;
  complete: boolean;
  settings?: Record<string, string>;
  databaseVolume?: string;
}
export async function installVps(
  envelope: SignedRelease,
  options: VpsOptions,
  releases = source,
  verify = verifyRelease,
) {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Run this installer with sudo on the Linux VPS.");
  await checkDirectory();
  let installation: Installation | undefined;
  if (await exists(`${directory}/installation.json`))
    installation = JSON.parse(
      await readFile(`${directory}/installation.json`, "utf8"),
    );
  const old = (await exists(`${directory}/.env`))
    ? await environment()
    : undefined;
  if (old && !installation && !options.adopt)
    throw new Error(
      "Existing Ephor settings found. Use --adopt to preserve the existing database and authentication secret.",
    );
  if (options.adopt && !old)
    throw new Error(
      "Copy the existing private environment into /var/lib/ephor/.env before adopting it. See the adoption guide.",
    );
  if (
    installation &&
    options.domain &&
    panelOrigin(options.domain) !== installation.origin
  )
    throw new Error(
      "The existing installation uses another domain. Its configuration was not changed.",
    );
  const url =
    installation?.origin ??
    panelOrigin(
      old?.EPHOR_ORIGIN ||
        options.domain ||
        (await options.ask("Panel domain (point its DNS to this VPS first)")),
    );
  const managedHttps =
    installation?.managedHttps ?? (!options.externalProxy && !options.adopt);
  const r = await verify(installation?.envelope ?? envelope);
  nativeArtifact(r);
  if (installation?.complete) {
    await healthy("http://127.0.0.1:3002", undefined, 3);
    console.info(
      `Ephor is already installed at ${url}. Use its Updates page for new releases. Setup code (if owner setup is unfinished): ${old?.EPHOR_SETUP_CODE ?? "unavailable"}`,
    );
    return;
  }
  if (!installation) {
    await stat("/run/systemd/system").catch(() => {
      throw new Error("A Linux VPS with systemd is required.");
    });
    if (managedHttps) {
      await lookup(new URL(url).hostname, { all: true }).catch(() => {
        throw new Error(
          `Create the DNS record for ${new URL(url).hostname} pointing to this VPS, then retry.`,
        );
      });
      for (const port of [80, 443])
        for (const host of ["0.0.0.0", "::"]) await availablePort(port, host);
    }
    await availablePort(3002, "127.0.0.1");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(`${directory}/updater.lock`, "wx", 0o600).catch(
    () => {
      throw new Error(
        "Another installation or update is running, or an interrupted process left /var/lib/ephor/updater.lock. Inspect its process before removing the lock.",
      );
    },
  );
  try {
    // Another invocation may have completed after our read-only preflight.
    const current = (await exists(`${directory}/installation.json`))
      ? JSON.parse(await readFile(`${directory}/installation.json`, "utf8"))
      : undefined;
    if (JSON.stringify(current) !== JSON.stringify(installation))
      throw new Error(
        "Installation state changed during preflight. Rerun the installer to resume it safely.",
      );
    await ensureDocker();
    if (
      !installation &&
      !options.adopt &&
      (await command(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          "label=com.docker.compose.project=ephor",
          "--format",
          "{{.ID}}",
        ],
        true,
        "/",
      ))
    )
      throw new Error(
        "Existing Ephor Compose containers found. Stop/remove those containers without deleting their volumes before adoption.",
      );
    if (!installation) {
      let databaseVolume: string | undefined;
      if (options.adopt) {
        databaseVolume = await options.ask(
          "Existing PostgreSQL 17 Docker volume name",
        );
        compose(r.image, databaseVolume);
        await command("docker", ["volume", "inspect", databaseVolume], true);
        if (
          await command(
            "docker",
            [
              "ps",
              "--filter",
              `volume=${databaseVolume}`,
              "--format",
              "{{.ID}}",
            ],
            true,
          )
        )
          throw new Error(
            "Stop the old database container before adoption. The volume must not be mounted in two database servers.",
          );
      }
      const secret = old?.BETTER_AUTH_SECRET ?? newSecret(48),
        db = old?.EPHOR_DB_PASSWORD ?? newSecret(32),
        setup = old?.EPHOR_SETUP_CODE ?? newSecret(24),
        token = randomBytes(32).toString("hex");
      if (
        !/^[a-f0-9]{64,128}$/i.test(secret) ||
        !/^[a-f0-9]{32,128}$/i.test(db) ||
        !/^[a-zA-Z0-9_-]{32,128}$/.test(setup)
      )
        throw new Error(
          "Existing database/authentication secrets must be hexadecimal for managed adoption. Do not regenerate them; see the adoption guide.",
        );
      installation = {
        origin: url,
        managedHttps,
        envelope,
        complete: false,
        databaseVolume,
        settings: {
          EPHOR_ORIGIN: url,
          EPHOR_DB_PASSWORD: db,
          BETTER_AUTH_SECRET: secret,
          EPHOR_SETUP_CODE: setup,
          EPHOR_PANEL_UPDATER_TOKEN: token,
        },
      };
      // Persist the generated secrets first, so interrupted installs can resume unchanged.
      await atomic(
        `${directory}/installation.json`,
        JSON.stringify(installation),
      );
    }
    const settings = installation.settings ?? (await environment());
    await mkdir(`${directory}/data`, { recursive: true, mode: 0o700 });
    await atomic(
      `${directory}/.env`,
      Object.entries(settings)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    );
    await atomic(
      `${directory}/updater.json`,
      JSON.stringify({
        token: settings.EPHOR_PANEL_UPDATER_TOKEN,
        databaseVolume: installation.databaseVolume,
        managedHttps,
        native: true,
      }),
    );
    await atomic(
      `${directory}/installed.json`,
      JSON.stringify({ sequence: r.sequence }),
    );
    await atomic(
      `${directory}/compose.yaml`,
      compose(r.image, installation.databaseVolume),
    );
    if (managedHttps) {
      if (!r.vps) throw new Error("Missing managed HTTPS release");
      await atomic(`${directory}/Caddyfile`, caddyfile(url));
      await atomic(
        `${directory}/compose.override.yaml`,
        proxyCompose(r.vps.caddyImage),
      );
    }
    console.info(
      "Starting Ephor, its private database and managed HTTPS. Certificates are issued and renewed automatically.",
    );
    await command("docker", [
      "compose",
      "--project-name",
      "ephor",
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "300",
    ]);
    await healthy("http://127.0.0.1:3002", r.version);
    await installUpdater(r, releases);
    if (managedHttps) await healthy(url, r.version, 150);
    installation.complete = true;
    delete installation.settings;
    await atomic(
      `${directory}/installation.json`,
      JSON.stringify(installation),
    );
    const env = await environment();
    console.info(
      `Open ${url}\nSetup code: ${env.EPHOR_SETUP_CODE}\nKeep /var/lib/ephor/.env and your database backups private and safe. Future updates are in the panel.${managedHttps ? "" : "\nConnect your existing HTTPS proxy to 127.0.0.1:3002."}`,
    );
  } finally {
    await lock.close();
    await unlink(`${directory}/updater.lock`);
  }
}

export async function dockerPoll(releases = source, verify = verifyRelease) {
  if (process.getuid?.() !== 0)
    throw new Error("Run the Docker updater as root.");
  await checkDirectory();
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
    const release = await verify(job.envelope);
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
      await command("docker", ["pull", release.image]);
      const installer = await releases.artifact(
        release,
        config.native ? nativeArtifact(release) : release.installer,
      );
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
      if (config.managedHttps)
        await atomic(
          `${directory}/compose.override.yaml`,
          proxyCompose(release.vps?.caddyImage ?? CADDY_IMAGE),
        );
      await command("docker", [
        "compose",
        "--project-name",
        "ephor",
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "300",
        "panel",
        ...(config.managedHttps ? ["https"] : []),
      ]);
      for (let i = 0; i < 60; i++) {
        const health = (await fetch("http://127.0.0.1:3002/health", {
          signal: AbortSignal.timeout(3000),
        })
          .then((r) => r.json())
          .catch(() => null)) as { version?: string } | null;
        if (health?.version === release.version) {
          if (config.managedHttps)
            await healthy(
              panelOrigin((await environment()).EPHOR_ORIGIN ?? ""),
              release.version,
            );
          await atomic(
            `${directory}/${config.native ? "ephor-installer" : "installer.mjs"}`,
            installer,
            config.native ? 0o700 : 0o600,
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
