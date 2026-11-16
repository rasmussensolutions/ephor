// Workers Builds detects the root build script when installing the template.
const script =
  process.env.WORKERS_CI === "1" ? "build:cloudflare" : "build:all";
const child = Bun.spawn(["bun", "run", script], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
