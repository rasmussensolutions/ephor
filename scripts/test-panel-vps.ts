import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const id = `ephor-vps-test-${randomBytes(4).toString("hex")}`;
const temporary = await mkdtemp(join(tmpdir(), "ephor-vps-test-"));
async function run(args: string[], capture = false) {
  const p = Bun.spawn(args, {
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const [output, code] = await Promise.all([
    capture ? new Response(p.stdout).text() : Promise.resolve(""),
    p.exited,
  ]);
  if (code) throw Error(`${args[0]} ${args[1]} failed (${code})`);
  return output.trim();
}
try {
  const arch = await run(
    ["docker", "info", "--format", "{{.Architecture}}"],
    true,
  );
  const target = ["aarch64", "arm64"].includes(arch) ? "arm64" : "x64";
  const flags = [
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    `--target=bun-linux-${target === "x64" ? "x64-baseline" : target}`,
  ];
  await run([
    "bun",
    "build",
    "scripts/tests/panel-vps-fixture.ts",
    ...flags,
    `--outfile=${temporary}/fixture`,
  ]);
  await run([
    "bun",
    "build",
    "scripts/install-panel.ts",
    ...flags,
    `--outfile=${temporary}/installer`,
  ]);
  await run([
    "docker",
    "build",
    "-f",
    "scripts/tests/panel-vps.Dockerfile",
    "-t",
    id,
    ".",
  ]);
  // Nested Docker is isolated: never mount the developer/runner's Docker socket.
  await run([
    "docker",
    "run",
    "-d",
    "--privileged",
    "--cgroupns=private",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--name",
    id,
    id,
  ]);
  await run(["docker", "cp", `${temporary}/fixture`, `${id}:/root/fixture`]);
  await run([
    "docker",
    "cp",
    `${temporary}/installer`,
    `${id}:/root/ephor-installer`,
  ]);
  await run([
    "docker",
    "cp",
    "deploy/panel/install.sh",
    `${id}:/root/install.sh`,
  ]);
  await run([
    "docker",
    "exec",
    id,
    "curl",
    "-fsSL",
    "https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/panel-release.json",
    "-o",
    "/root/release.json",
  ]);
  await run([
    "docker",
    "exec",
    id,
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "/root/test.key",
    "-out",
    "/root/test.crt",
    "-days",
    "2",
    "-subj",
    "/CN=panel.ephor.test",
    "-addext",
    "subjectAltName=DNS:panel.ephor.test",
  ]);
  await run([
    "docker",
    "exec",
    "-e",
    "NODE_EXTRA_CA_CERTS=/root/test.crt",
    id,
    "/root/fixture",
  ]);
} finally {
  await run(["docker", "rm", "-f", id]).catch(() => {});
  await run(["docker", "image", "rm", id]).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
