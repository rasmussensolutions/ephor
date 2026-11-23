// Disposable network namespace; never mount a host socket or host firewall paths.
const name = `ephor-protections-test-${crypto.randomUUID()}`;
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error(`Protection test failed: ${args[0]}`);
}
await run([
  "docker",
  "buildx",
  "build",
  "--load",
  "-t",
  "ephor-protections-test",
  "-f",
  "deploy/daemon/protections-test.Dockerfile",
  ".",
]);
try {
  await run([
    "docker",
    "run",
    "--name",
    name,
    "--cap-add",
    "NET_ADMIN",
    "ephor-protections-test",
    "/protection-tests",
    "protections::tests::linux_crowdsec_lifecycle",
    "--ignored",
    "--nocapture",
    "--test-threads=1",
  ]);
} finally {
  await run(["docker", "rm", "-f", name]);
}
