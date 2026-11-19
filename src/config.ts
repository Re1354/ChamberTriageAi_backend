import { existsSync } from "node:fs";
import { z } from "zod";

// লোকাল ডেভেলপমেন্টে apps/api/.env পড়া (প্রোডাকশনে Render-এর env ব্যবহার হয়)
if (process.env.NODE_ENV !== "production" && existsSync(".env")) {
  process.loadEnvFile(".env");
}

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["true", "1", "yes"].includes(v.toLowerCase())));

const EnvSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().int().default(4100),
    HOST: z.string().default("0.0.0.0"),

    DATABASE_URL: z.string().min(1, "DATABASE_URL দরকার"),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(5),
    DB_SSL: bool(true),

    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_JWT_SECRET: z.string().optional(),
    STORAGE_BUCKET: z.string().default("visit-media"),

    GEMINI_API_KEY: z.string().optional(),
    MOCK_LLM: bool(false),
    MODEL_TURN: z.string().default("gemini-3.1-flash-lite"),
    MODEL_FINAL: z.string().default("gemini-3.5-flash-lite"),
    EMBEDDING_MODEL: z.string().optional().default(""),
    DAILY_RPD_TURN: z.coerce.number().int().min(0).default(500),
    DAILY_RPD_FINAL: z.coerce.number().int().min(0).default(500),
    QUOTA_SAFETY: z.coerce.number().min(0.1).max(1).default(0.85),

    ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
    FRONTEND_URL: z.string().default("http://localhost:3000"),

    CRON_SECRET: z.string().min(16, "CRON_SECRET অন্তত ১৬ অক্ষর"),
    IP_HASH_SALT: z.string().min(8),

    IMAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
    MAX_NEW_VISITS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(5),
    CROSS_DOCTOR_SEARCH_PER_HOUR: z.coerce.number().int().min(1).default(60),
    CROSS_DOCTOR_VIEW_WINDOW_HOURS: z.coerce.number().int().min(1).default(12),

    RUN_WORKER: bool(true),
    CHECKPOINTER: z.enum(["postgres", "memory"]).default("postgres"),
  });

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Environment ভুল/অসম্পূর্ণ:");
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

/** AI ব্যবহারযোগ্য কিনা। key না থাকলে সার্ভার ক্র্যাশ না করে "no_ai" (নিয়ম-ভিত্তিক) মোডে চলে। */
export const aiConfigured = env.MOCK_LLM || !!env.GEMINI_API_KEY;
if (!aiConfigured) {
  console.warn("⚠️  GEMINI_API_KEY নেই — AI বন্ধ; প্রশ্ন-ব্যাংক ও নিয়ম-ভিত্তিক সামারি দিয়ে চলবে।");
}
