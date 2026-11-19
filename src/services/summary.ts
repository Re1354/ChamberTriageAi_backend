import type { AiMode, RedFlagLevel, Sex, SummaryCard, UploadKind } from "@chamberai/shared";
import { truncate } from "@chamberai/shared";
import { q, q1 } from "../db";
import { maxLevel } from "../clinical/redFlags";
import { emitDoctorEvent } from "../lib/events";
import { runSummaryGraph } from "../graph/summaryGraph";
import { PROMPT_VERSION } from "../llm/prompts";
import type { StoredInterviewState } from "../graph/state";
import type { SummaryInput } from "./summaryBuild";

interface VisitForSummary {
  id: string;
  doctor_id: string;
  ai_mode: AiMode;
  age_years: number | null;
  sex: Sex | null;
  status: string;
  red_flag_level: RedFlagLevel;
  chief_complaint_short: string | null;
  interview_state: StoredInterviewState | null;
}

export async function enqueueSummary(visitId: string): Promise<void> {
  await q(
    `insert into public.jobs as j (type, dedupe_key, payload) values ('summarize', $1, $2)
     on conflict (type, dedupe_key) do update
       set status = 'queued', run_after = now(), attempts = 0, last_error = null
       where j.status in ('failed', 'done')`,
    [visitId, JSON.stringify({ visitId })],
  );
}

/** Summarizer agent চালিয়ে সামারি সেভ করা (worker থেকে ডাকা হয়) */
export async function summarizeVisit(visitId: string): Promise<void> {
  const v = await q1<VisitForSummary>(
    `select id, doctor_id, ai_mode, age_years, sex, status, red_flag_level, chief_complaint_short, interview_state
       from public.visits where id = $1`,
    [visitId],
  );
  if (!v || !v.interview_state) return;

  const messages = await q<{ id: string; role: "assistant" | "patient"; question_id: string | null; text_bn: string | null }>(
    "select id::text as id, role, question_id, text_bn from public.messages where visit_id = $1 order by id",
    [visitId],
  );
  const uploads = await q<{ id: string; kind: UploadKind; storage_path: string; content_type: string | null }>(
    `select id, kind, storage_path, content_type from public.uploads
      where visit_id = $1 and submitted and deleted_at is null order by created_at`,
    [visitId],
  );

  const input: SummaryInput = {
    visitId,
    doctorId: v.doctor_id,
    mode: v.interview_state.mode ?? v.ai_mode,
    ageYears: v.age_years,
    sex: v.sex,
    state: v.interview_state,
    messages: messages.map((m) => ({ id: m.id, role: m.role, questionId: m.question_id, text: m.text_bn ?? "" })),
    uploads: uploads.map((u) => ({ id: u.id, kind: u.kind, path: u.storage_path, contentType: u.content_type })),
  };

  const out = await runSummaryGraph(input);
  const card: SummaryCard = {
    ...out.card,
    generatedBy: out.generatedBy,
    verifyOk: out.issues.length === 0,
    verifyIssues: out.issues,
  };

  await q(
    `insert into public.summaries (visit_id, summary, generated_by, verify_ok, model, prompt_version, tokens_in, tokens_out, latency_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (visit_id) do update set
       summary = excluded.summary, generated_by = excluded.generated_by, verify_ok = excluded.verify_ok,
       model = excluded.model, prompt_version = excluded.prompt_version, tokens_in = excluded.tokens_in,
       tokens_out = excluded.tokens_out, latency_ms = excluded.latency_ms`,
    [
      visitId,
      JSON.stringify(card),
      out.generatedBy,
      card.verifyOk,
      out.meta.model,
      PROMPT_VERSION,
      out.meta.tokensIn,
      out.meta.tokensOut,
      out.meta.latencyMs,
    ],
  );

  let level: RedFlagLevel = v.red_flag_level;
  for (const a of out.labAlerts) {
    const ins = await q1<{ id: string }>(
      `insert into public.alerts (visit_id, doctor_id, level, rule_id, reason_bn) values ($1, $2, $3, $4, $5)
       on conflict (visit_id, rule_id) do nothing returning id`,
      [visitId, v.doctor_id, a.level, a.ruleId, a.reasonBn],
    );
    if (ins) await emitDoctorEvent(v.doctor_id, visitId, "alert");
    level = maxLevel(level, a.level);
  }

  await q(
    `update public.visits set
        status = case when status in ('started', 'interviewing', 'finishing', 'abandoned') then 'completed' else status end,
        completed_at = coalesce(completed_at, now()),
        chief_complaint_short = coalesce(chief_complaint_short, $2),
        red_flag_level = $3
      where id = $1`,
    [visitId, truncate(card.chiefComplaint.text, 120), level],
  );
  await emitDoctorEvent(v.doctor_id, visitId, "summary_ready");
}
