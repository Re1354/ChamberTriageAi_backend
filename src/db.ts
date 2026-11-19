import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { env } from "./config";

// DATE কলামকে JS Date-এ না বদলে "YYYY-MM-DD" স্ট্রিং রাখি (টাইমজোন-ঝামেলা এড়াতে)
pg.types.setTypeParser(1082, (v: string) => v);
// BIGINT/COUNT → number
pg.types.setTypeParser(20, (v: string) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
});

// ডিবাগ: DEBUG_DB=1 দিলে প্রতিটি কুয়েরির সময় লগ হয় (লেটেন্সি মাপার জন্য)
if (process.env.DEBUG_DB === "1") {
  const orig = pg.Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Client.prototype as any).query = function (this: unknown, ...args: any[]) {
    const t = Date.now();
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
    const log = () => console.log(`[db] ${Date.now() - t}ms ${String(text).replace(/\s+/g, " ").slice(0, 70)}`);
    const cbIdx = args.findIndex((a) => typeof a === "function");
    if (cbIdx >= 0) {
      const cb = args[cbIdx];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args[cbIdx] = (...cbArgs: any[]) => {
        log();
        return cb(...cbArgs);
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (orig as any).apply(this, args);
    if (cbIdx < 0 && r && typeof r.then === "function") r.then(log, () => undefined);
    return r;
  };
}

pool.on("error", (err) => {
  console.error("[db] idle client error", err.message);
});

export async function q<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as unknown[]);
  return res.rows;
}

export async function q1<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}
