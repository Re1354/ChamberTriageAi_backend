import type { MetricsResponse } from "@chamberai/shared";
import { env } from "../config";
import { q, q1 } from "../db";
import { deleteInterviewThread } from "../graph/interviewGraph";
import { quotaDay, remaining, dailyBudget } from "../llm/quota";
import { storage } from "../supabase";

/** দৈনিক ক্লিনআপ (cron-job.org থেকে) — ফ্রি স্টোরেজ/ডাটাবেস সীমার ভেতরে রাখে */
export async function runCleanup() {
  const result = { imagesDeleted: 0, visitsAbandoned: 0, rateLimitRows: 0, events: 0, jobs: 0 };

  // ১. মেয়াদোত্তীর্ণ ছবি (Storage থেকে মুছে uploads.deleted_at)
  for (let batch = 0; batch < 10; batch++) {
    const old = await q<{ id: string; storage_path: string }>(
      `select id, storage_path from public.uploads
        where deleted_at is null and created_at < now() - make_interval(days => $1)
        order by created_at limit 200`,
      [env.IMAGE_RETENTION_DAYS],
    );
    if (!old.length) break;
    await storage().remove(old.map((o) => o.storage_path));
    await q("update public.uploads set deleted_at = now() where id = any($1::uuid[])", [old.map((o) => o.id)]);
    result.imagesDeleted += old.length;
  }

  // ২. ৬ ঘণ্টার বেশি অসম্পূর্ণ ইন্টারভিউ → abandoned + checkpoint মোছা
  const stale = await q<{ id: string }>(
    `update public.visits set status = 'abandoned', step_lock_until = null
      where status in ('started', 'interviewing') and updated_at < now() - interval '6 hours'
      returning id`,
  );
  for (const v of stale) await deleteInterviewThread(v.id);
  result.visitsAbandoned = stale.length;

  // ৩. পুরনো টেকনিক্যাল সারি
  result.rateLimitRows = (await q<{ n: number }>(
    "with d as (delete from public.rate_limits where window_start < now() - interval '2 days' returning 1) select count(*)::int as n from d",
  ))[0]?.n ?? 0;
  result.events = (await q<{ n: number }>(
    "with d as (delete from public.doctor_events where created_at < now() - interval '3 days' returning 1) select count(*)::int as n from d",
  ))[0]?.n ?? 0;
  result.jobs = (await q<{ n: number }>(
    "with d as (delete from public.jobs where status = 'done' and finished_at < now() - interval '7 days' returning 1) select count(*)::int as n from d",
  ))[0]?.n ?? 0;

  return result;
}

let metricsCache: { at: number; data: MetricsResponse } | null = null;

/** /docs পেজের জন্য এগ্রিগেট মেট্রিক্স — কোনো রোগীর ব্যক্তিগত তথ্য নয় */
export async function getMetrics(): Promise<MetricsResponse> {
  if (metricsCache && Date.now() - metricsCache.at < 30_000) return metricsCache.data;
  const today = "(now() at time zone 'Asia/Dhaka')::date";
  const counts = await q1<{ visits: number; completed: number; alerts: number }>(
    `select
       (select count(*)::int from public.visits where visit_date = ${today}) as visits,
       (select count(*)::int from public.visits where visit_date = ${today} and status in ('completed', 'seen')) as completed,
       (select count(*)::int from public.alerts a join public.visits v on v.id = a.visit_id where v.visit_date = ${today}) as alerts`,
  );
  const modes = await q<{ mode: string; count: number }>(
    `select ai_mode as mode, count(*)::int as count from public.visits where visit_date = ${today} group by ai_mode`,
  );
  const llm = await q1<{ calls: number; avg_latency: number | null }>(
    "select count(*)::int as calls, avg(latency_ms)::int as avg_latency from public.llm_usage where quota_day = $1::date and ok",
    [quotaDay()],
  );
  const perVisit = await q1<{ avg_calls: number | null; avg_tokens: number | null }>(
    `select avg(c)::float as avg_calls, avg(t)::float as avg_tokens from (
       select u.visit_id, count(*) as c, sum(coalesce(u.tokens_in, 0) + coalesce(u.tokens_out, 0)) as t
         from public.llm_usage u join public.visits v on v.id = u.visit_id
        where u.ok and v.status in ('completed', 'seen') and v.created_at > now() - interval '7 days'
        group by u.visit_id) x`,
  );
  const data: MetricsResponse = {
    generatedAt: new Date().toISOString(),
    visitsToday: counts?.visits ?? 0,
    completedToday: counts?.completed ?? 0,
    alertsToday: counts?.alerts ?? 0,
    modeBreakdown: modes,
    llmCallsToday: llm?.calls ?? 0,
    avgCallsPerCompletedVisit: perVisit?.avg_calls != null ? Math.round(perVisit.avg_calls * 10) / 10 : null,
    avgTokensPerCompletedVisit: perVisit?.avg_tokens != null ? Math.round(perVisit.avg_tokens) : null,
    avgLatencyMs: llm?.avg_latency ?? null,
    remainingQuota: {
      turn: env.MOCK_LLM ? dailyBudget("turn") : Math.max(0, await remaining("turn")),
      final: env.MOCK_LLM ? dailyBudget("final") : Math.max(0, await remaining("final")),
    },
  };
  metricsCache = { at: Date.now(), data };
  return data;
}
