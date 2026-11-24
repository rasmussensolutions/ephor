import { randomBytes } from "node:crypto";
import { PUBLIC_KEY } from "../packages/api/src/panel/release/manifest";

const image = process.argv[2];
if (!image) throw new Error("Usage: bun scripts/test-panel-image.ts <image>");
const id = `ephor-release-test-${randomBytes(4).toString("hex")}`;
async function docker(...args: string[]) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code)
    throw new Error(
      `Docker ${args[0]} ${args[2] ?? ""} failed (${code}): ${err || out}`,
    );
  return (args[0] === "logs" ? out + err : out).trim();
}
const setupCode = `0123456789abcdef${randomBytes(24).toString("hex")}`;
const env = [
  "-e",
  "EPHOR_PANEL_UPDATER_TOKEN=image-test-token",
  "-e",
  `DATABASE_URL=postgresql://ephor:test@${id}-db:5432/ephor`,
  "-e",
  "EPHOR_ORIGIN=https://image-test.example",
  "-e",
  `BETTER_AUTH_SECRET=0123456789abcdef${randomBytes(48).toString("hex")}`,
  "-e",
  `EPHOR_SETUP_CODE=${setupCode}`,
];
try {
  await docker("network", "create", id);
  await docker(
    "run",
    "-d",
    "--name",
    `${id}-db`,
    "--network",
    id,
    "-e",
    "POSTGRES_USER=ephor",
    "-e",
    "POSTGRES_PASSWORD=test",
    "postgres:17-alpine",
  );
  for (let i = 0; i < 60; i++) {
    try {
      await docker("exec", `${id}-db`, "pg_isready", "-U", "ephor");
      break;
    } catch {
      await Bun.sleep(1000);
    }
  }
  await docker(
    "run",
    "-d",
    "--name",
    id,
    "--network",
    id,
    "-p",
    "127.0.0.1::3002",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${id}-data:/data`,
    ...env,
    image,
  );
  const address = await docker("port", id, "3002/tcp");
  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error("Unexpected test port");
  let base = `http://${address}`;
  const health = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const body = (await response.json()) as { version?: string };
        if (response.ok && body.version) return;
      } catch {
        /* The container may still be starting. */
      }
      await Bun.sleep(1000);
    }
    throw new Error(`Panel did not start: ${await docker("logs", id)}`);
  };
  await health();
  const enrollmentScript = await fetch(`${base}/api/agent/install.sh`);
  const enrollmentText = await enrollmentScript.text();
  if (
    !enrollmentScript.ok ||
    !enrollmentText.includes(`configure-updater '${PUBLIC_KEY}'`)
  )
    throw new Error(
      `Official image did not enable the machine updater by default (HTTP ${enrollmentScript.status}, updater instruction: ${enrollmentText.includes("configure-updater")}, signing key: ${enrollmentText.includes(PUBLIC_KEY)}).`,
    );
  const poll = await fetch(`${base}/api/panel-updater/poll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer image-test-token",
    },
    body: "{}",
    signal: AbortSignal.timeout(10000),
  });
  await poll.text();
  if (poll.status !== 200)
    throw new Error(`Host updater authentication failed: ${poll.status}`);
  const setupRequest = await fetch(`${base}/api/setup/start`, {
    method: "POST",
    headers: {
      Origin: "https://image-test.example",
      "Content-Type": "application/json",
    },
    body: '{"code":"invalid"}',
    signal: AbortSignal.timeout(10000),
  });
  await setupRequest.text();
  if (setupRequest.status < 400 || setupRequest.status >= 500)
    throw new Error(
      "Setup request did not safely reject an invalid credential",
    );
  const enrollment = await fetch(`${base}/api/setup/start`, {
    method: "POST",
    headers: {
      Origin: "https://image-test.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code: setupCode }),
    signal: AbortSignal.timeout(10000),
  });
  await enrollment.text();
  if (enrollment.status !== 200 || !enrollment.headers.get("set-cookie"))
    throw new Error(
      "Initial setup code could not create an owner enrollment session",
    );
  const migrations = await docker(
    "exec",
    `${id}-db`,
    "psql",
    "-U",
    "ephor",
    "-Atc",
    "SELECT count(*) FROM ephor_migrations",
  );
  if (Number(migrations) < 27) throw new Error("Migrations not applied");
  // Force one safe migration to run again and verify backup + transaction on restart.
  await docker(
    "exec",
    `${id}-db`,
    "psql",
    "-U",
    "ephor",
    "-c",
    "DELETE FROM ephor_migrations WHERE name='0027_panel_releases.sql'; DROP TABLE ephor_panel_release; CREATE TABLE recovery_canary(value TEXT); INSERT INTO recovery_canary VALUES ('preserve me');",
  );
  await docker("restart", id);
  const restartedAddress = await docker("port", id, "3002/tcp");
  if (!/^127\.0\.0\.1:\d+$/.test(restartedAddress))
    throw new Error("Unexpected restarted test port");
  base = `http://${restartedAddress}`;
  await health();
  const backup = await docker(
    "exec",
    id,
    "sh",
    "-c",
    "find /data/backups -name '*.dump' -type f | head -1",
  );
  if (!backup) throw Error("Recovery archive missing");
  await docker("exec", id, "pg_restore", "--list", backup);
  const canary = await docker(
    "exec",
    `${id}-db`,
    "psql",
    "-U",
    "ephor",
    "-Atc",
    "SELECT value FROM recovery_canary",
  );
  if (canary !== "preserve me") throw Error("Data was lost");
  const user = await docker(
    "exec",
    id,
    "sh",
    "-c",
    "awk '/^Uid:/{print $2}' /proc/1/status",
  );
  if (user !== "1000") throw Error("Panel is not running unprivileged");
  console.info(
    "Release image: install, health, restart, migrations, backup and data preservation passed.",
  );
} catch (error) {
  console.error(
    await docker("inspect", "--format", "{{json .State}}", id).catch(
      () => "No panel container",
    ),
  );
  console.error(await docker("logs", id).catch(() => "No panel logs"));
  throw error;
} finally {
  await docker("rm", "-f", id, `${id}-db`).catch(() => {});
  await docker("volume", "rm", `${id}-data`).catch(() => {});
  await docker("network", "rm", id).catch(() => {});
}
