/**
 * ডাটাবেস সেটআপ — supabase/migrations/*.sql ক্রমানুসারে একবার করে চালায়।
 *   রুট থেকে:  npm run db:migrate            (শুধু টেবিল)
 *              npm run db:migrate -- --seed   (টেবিল + নমুনা ওষুধ/উপসর্গ)
 * শুধু DATABASE_URL লাগে (apps/api/.env থেকে)। আগে চালানো ফাইল আবার চালায় না।
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ apps/api/.env-এ DATABASE_URL নেই।");
  process.exit(1);
}

const root = fileURLToPath(new URL("../supabase/", import.meta.url));
const migrationsDir = `${root}migrations/`;
const withSeed = process.argv.includes("--seed");

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
});

try {
  await client.connect();
} catch (err) {
  console.error("❌ ডাটাবেসে সংযোগ হয়নি:", (err as Error).message);
  console.error(
    "   direct connection (db.<ref>.supabase.co) IPv6-এ চলে। Supabase → Connect → \"Session pooler\" স্ট্রিং DATABASE_URL-এ দিয়ে আবার চেষ্টা করুন।",
  );
  process.exit(1);
}

await client.query(
  "create table if not exists public._app_migrations (name text primary key, applied_at timestamptz not null default now())",
);
await client.query("alter table public._app_migrations enable row level security");
const done = new Set((await client.query<{ name: string }>("select name from public._app_migrations")).rows.map((r) => r.name));

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of files) {
  if (done.has(file)) {
    console.log(`✓ ${file} (আগেই চালানো)`);
    continue;
  }
  const sql = readFileSync(`${migrationsDir}${file}`, "utf8");
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into public._app_migrations (name) values ($1)", [file]);
    await client.query("commit");
    console.log(`✅ ${file}`);
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    console.error(`❌ ${file} ব্যর্থ:`, (err as Error).message);
    await client.end();
    process.exit(1);
  }
}

if (withSeed) {
  const seed = readFileSync(`${root}seed.sql`, "utf8");
  await client.query(seed);
  console.log("✅ seed.sql (নমুনা ওষুধ ও উপসর্গ)");
}

await client.end();
console.log("🎉 ডাটাবেস প্রস্তুত।");
