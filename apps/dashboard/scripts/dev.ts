export {};

// Vite initializes its dependency cache before --strictPort rejects a second
// server. Check first so a duplicate launch cannot remove the running UI's deps.
try {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 3000,
    socket: { data() {} },
  });
  listener.stop(true);
} catch {
  console.error(
    "Dashboard port 3000 is already in use. Use the running dashboard or stop it before starting another development server.",
  );
  process.exit(1);
}

const child = Bun.spawn(["vite", "dev", "--port", "3000", "--strictPort"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exit(await child.exited);
