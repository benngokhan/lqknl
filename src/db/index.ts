import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    statement_timeout: 30000,
  });

// Graceful shutdown
if (process.env.NODE_ENV === "production") {
  process.on("SIGTERM", async () => {
    await pool.end();
    process.exit(0);
  });
}

// Reuse one pool across route bundles in every environment. Without the
// production global, independently bundled route handlers can create multiple
// pools and exhaust the hosted PostgreSQL connection limit.
globalForDb.__arenaNextJsPostgresqlPool = pool;

export const db = drizzle(pool);
