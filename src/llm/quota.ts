import type { AiMode } from "@chamberai/shared";
import { aiConfigured, env } from "../config";
import { q, q1 } from "../db";

export type LlmPurpose = "turn" | "final" | "embed" | "eval" | "other";
export type QuotaKind = "turn" | "final";

/** Gemini-র দৈনিক কোটা প্যাসিফিক মধ্যরাতে রিসেট হয় (= বাংলাদেশে দুপুর ১টা/২টা) */
export function quotaDay(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export function modelFor(kind: QuotaKind): string {
  return kind === "turn" ? env.MODEL_TURN : env.MODEL_FINAL;
}

export function dailyBudget(kind: QuotaKind): number {
  const raw = kind === "turn" ? env.DAILY_RPD_TURN : env.DAILY_RPD_FINAL;
  return Math.floor(raw * env.QUOTA_SAFETY);
}

// ছোট in-memory ক্যাশ (প্রতি ইনস্ট্যান্সে ১০ সেকেন্ড) — প্রতিটি কলে DB-তে গোনা এড়াতে
const usedCache = new Map<string, { used: number; at: number }>();

async function usedToday(model: string): Promise<number> {
  const key = `${quotaDay()}:${model}`;
  const cached = usedCache.get(key);
  if (cached && Date.now() - cached.at < 10_000) return cached.used;
  const row = await q1<{ n: number }>(
    "select count(*)::int as n from public.llm_usage where quota_day = $1::date and model = $2 and ok",
    [quotaDay(), model],
  );
  const used = row?.n ?? 0;
  usedCache.set(key, { used, at: Date.now() });
  return used;
}

export async function remaining(kind: QuotaKind): Promise<number> {
  if (env.MOCK_LLM) return Number.MAX_SAFE_INTEGER;
  if (!aiConfigured) return 0;
  return dailyBudget(kind) - (await usedToday(modelFor(kind)));
}

export async function canUseAi(kind: QuotaKind): Promise<boolean> {
  return (await remaining(kind)) > 0;
}

/**
 * নতুন ইন্টারভিউর মোড বাছাই:
 *   standard → প্রতিটি উত্তর AI বোঝে
 *   lean     → প্রথম ২টি উত্তর AI, বাকিটা প্রশ্ন-ব্যাংক
 *   economy  → প্রশ্ন-ব্যাংক + শেষে AI সামারি
 *   no_ai    → AI নেই, ডাক্তার কাঁচা প্রশ্নোত্তর দেখবেন
 */
export async function chooseMode(doctorId: string, doctorDailyAiLimit: number): Promise<AiMode> {
  if (env.MOCK_LLM) return "standard";
  const finalLeft = await remaining("final");
  if (finalLeft <= 0) return "no_ai";

  const row = await q1<{ n: number }>(
    `select count(*)::int as n from public.visits
      where doctor_id = $1
        and visit_date = (now() at time zone 'Asia/Dhaka')::date
        and ai_mode in ('standard', 'lean')`,
    [doctorId],
  );
  if ((row?.n ?? 0) >= doctorDailyAiLimit) return "economy";

  const turnLeft = await remaining("turn");
  if (turnLeft >= 40) return "standard";
  if (turnLeft >= 10) return "lean";
  return "economy";
}

export interface UsageRecord {
  model: string;
  purpose: LlmPurpose;
  ok: boolean;
  errorCode?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
  visitId?: string | null;
  doctorId?: string | null;
}

export async function recordUsage(u: UsageRecord): Promise<void> {
  await q(
    `insert into public.llm_usage (model, purpose, ok, error_code, tokens_in, tokens_out, latency_ms, visit_id, doctor_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [u.model, u.purpose, u.ok, u.errorCode ?? null, u.tokensIn ?? null, u.tokensOut ?? null, u.latencyMs ?? null, u.visitId ?? null, u.doctorId ?? null],
  ).catch((err) => console.warn("[quota] failed to record usage", err.message));
  if (u.ok) {
    const c = usedCache.get(`${quotaDay()}:${u.model}`);
    if (c) c.used += 1;
  }
}
