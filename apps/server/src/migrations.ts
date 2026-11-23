import { spawn } from "node:child_process";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { PANEL_VERSION } from "../../../packages/api/src/panel/release/version";
export async function migrateInstallation(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    // One connection holds the lock through backup and migration, across all replicas.
    await client.query("SELECT pg_advisory_lock(76381025)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS ephor_migrations (name TEXT PRIMARY KEY)",
    );
    const applied = new Set(
      (
        await client.query<{ name: string }>(
          "SELECT name FROM ephor_migrations",
        )
      ).rows.map((r) => r.name),
    );
    const directory = "packages/api/migrations/postgres";
    const pending = (await readdir(directory))
      .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n) && !applied.has(n))
      .sort();
    if (!pending.length) return;
    if (applied.size) {
      const backupDir = "/data/backups";
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const path = join(
          backupDir,
          `before-${PANEL_VERSION}-${Date.now()}.dump`,
        ),
        tmp = `${path}.partial`;
      const file = await open(tmp, "wx", 0o600);
      try {
        await new Promise<void>((resolve, reject) => {
          // The database URL stays in the child environment, never in arguments or logs.
          const database = new URL(process.env.DATABASE_URL ?? "");
          const child = spawn(
            "pg_dump",
            ["--format=custom", "--no-owner", "--no-acl"],
            {
              env: {
                ...process.env,
                PGHOST: database.hostname,
                PGPORT: database.port || "5432",
                PGUSER: decodeURIComponent(database.username),
                PGPASSWORD: decodeURIComponent(database.password),
                PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
                PGSSLMODE: database.searchParams.get("sslmode") || "prefer",
                ...(database.searchParams.has("sslrootcert")
                  ? {
                      PGSSLROOTCERT:
                        database.searchParams.get("sslrootcert") ?? "",
                    }
                  : {}),
              },
              timeout: 300_000,
              stdio: ["ignore", file.fd, "ignore"],
            },
          );
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(
                    "Database backup failed; migrations were not applied.",
                  ),
                ),
          );
        });
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      console.info(`Database recovery archive: ${path}`);
    }
    await client.query("BEGIN");
    try {
      for (const name of pending) {
        await client.query(await readFile(join(directory, name), "utf8"));
        await client.query("INSERT INTO ephor_migrations (name) VALUES ($1)", [
          name,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(76381025)");
    client.release();
  }
}
