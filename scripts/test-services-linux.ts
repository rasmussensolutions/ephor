// Disposable nested Docker engine. Never mount the host Docker socket into the fixture.
const name = `ephor-services-test-${crypto.randomUUID()}`;
async function run(args: string[]) {
  const process = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  if (await process.exited) throw new Error(`Test command failed: ${args[0]}`);
}
await run([
  "docker",
  "buildx",
  "build",
  "--load",
  "-t",
  "ephor-services-test",
  "-f",
  "deploy/daemon/services-test.Dockerfile",
  ".",
]);
const security = process.argv[2] === "security::";
if (security)
  await run([
    "docker",
    "buildx",
    "build",
    "--load",
    "-t",
    "ephor-security-test",
    "-f",
    "deploy/daemon/security-test.Dockerfile",
    ".",
  ]);
try {
  await run([
    "docker",
    "run",
    "-d",
    "--privileged",
    "--name",
    name,
    "--env",
    "DOCKER_TLS_CERTDIR=",
    security ? "ephor-security-test" : "ephor-services-test",
    "dockerd",
    "--host=unix:///var/run/docker.sock",
    // Catalog and restore fixtures intentionally retain more networks than the
    // default Docker pools can allocate. This config affects only this engine.
    "--default-address-pool=base=10.240.0.0/16,size=24",
  ]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const probe = Bun.spawn(["docker", "exec", name, "docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await probe.exited) === 0) {
      ready = true;
      break;
    }
    await Bun.sleep(1000);
  }
  if (!ready) throw new Error("Isolated Docker engine did not become ready");
  await run(["docker", "exec", name, "df", "-h", "/var/lib/docker"]);
  await run([
    "docker",
    "exec",
    name,
    "/service-tests",
    process.argv[2] ?? "services::",
    "--ignored",
    "--test-threads=1",
    "--nocapture",
  ]);
} catch (error) {
  // Preserve disk diagnostics before deleting the disposable engine and its volumes.
  await run(["docker", "exec", name, "df", "-h", "/var/lib/docker"]).catch(
    () => {},
  );
  await run(["docker", "exec", name, "docker", "system", "df"]).catch(() => {});
  await run(["docker", "exec", name, "docker", "network", "ls"]).catch(
    () => {},
  );
  throw error;
} finally {
  await run(["docker", "rm", "-fv", name]);
}
