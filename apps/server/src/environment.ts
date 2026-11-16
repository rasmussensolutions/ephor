import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AuthEnvironment, type Sql, validateConfig } from "@ephor/api";
import pg from "pg";

export const daemonDirectory =
  process.env.EPHOR_DAEMON_DIST ??
  (process.env.EPHOR_ASSETS_DIR
    ? join(process.env.EPHOR_ASSETS_DIR, "daemon")
    : fileURLToPath(new URL("../../dashboard/public/daemon", import.meta.url)));

export function environment() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });
  const sql: Sql = {
    async query<T extends Record<string, unknown>>(
      query: string,
      values: unknown[] = [],
    ) {
      return (await pool.query<T>(query, values)).rows;
    },
  };
  const env: AuthEnvironment = {
    origin: process.env.EPHOR_ORIGIN ?? "",
    secret: process.env.BETTER_AUTH_SECRET ?? "",
    database: pool,
    sql,
    releaseUrl: process.env.EPHOR_RELEASE_URL,
    releasePublicKey: process.env.EPHOR_RELEASE_PUBLIC_KEY,
    loadDaemonRelease: async () =>
      JSON.parse(
        await readFile(join(daemonDirectory, "manifest.json"), "utf8"),
      ),
  };
  validateConfig(env);
  return { env, pool };
}
