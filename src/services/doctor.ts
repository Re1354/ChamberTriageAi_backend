import {
  isIsoDate,
  normalizePatientCode,
  PATIENT_CODE_REGEX,
  todayInDhaka,
  type AlertItem,
  type SearchResultItem,
  type SummaryCard,
  type VisitDetail,
  type VisitListItem,
  type VisitUpload,
  type UpdateOwnProfileBody,
} from "@chamberai/shared";
import type { DoctorRow } from "../auth";
import { env } from "../config";
import { q, q1 } from "../db";
import { forbidden, HttpError, notFound } from "../errors";
import { audit, emitDoctorEvent } from "../lib/events";
import { enforceRateLimit } from "../lib/rateLimit";
import { storage } from "../supabase";

interface VisitDbRow {
  id: string;
  doctor_id: string;
  patient_code: string;
  visit_date: string;
  created_at: string | Date;
  age_years: number | null;
  sex: VisitListItem["sex"];
  status: VisitListItem["status"];
  ai_mode: VisitListItem["aiMode"];
  red_flag_level: VisitListItem["redFlagLevel"];
  category: VisitListItem["category"];
  chief_complaint_short: string | null;
  has_summary: boolean;
}

const LIST_COLUMNS = `v.id, v.doctor_id, v.patient_code, v.visit_date, v.created_at, v.age_years, v.sex, v.status,
  v.ai_mode, v.red_flag_level, v.category, v.chief_complaint_short, (s.visit_id is not null) as has_summary`;

function iso(d: string | Date): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function toListItem(r: VisitDbRow): VisitListItem {
  return {
    id: r.id,
    doctorId: r.doctor_id,
    patientCode: r.patient_code,
    visitDate: r.visit_date,
    createdAt: iso(r.created_at),
    ageYears: r.age_years,
    sex: r.sex,
    status: r.status,
    aiMode: r.ai_mode,
    redFlagLevel: r.red_flag_level,
    category: r.category,
    chiefComplaintShort: r.chief_complaint_short,
    hasSummary: r.has_summary,
  };
}

function dateOrToday(date?: string): string {
  return date && isIsoDate(date) ? date : todayInDhaka();
}

/** নিজের রোগী-তালিকা (শুধু নিজের) */
export async function listOwnVisits(doctor: DoctorRow, date?: string): Promise<VisitListItem[]> {
  const rows = await q<VisitDbRow>(
    `select ${LIST_COLUMNS}
       from public.visits v left join public.summaries s on s.visit_id = v.id
      where v.doctor_id = $1 and v.visit_date = $2::date
      order by (v.red_flag_level = 'emergency') desc, (v.red_flag_level = 'urgent') desc, v.created_at desc
      limit 500`,
    [doctor.id, dateOrToday(date)],
  );
  return rows.map(toListItem);
}

/**
 * কোড দিয়ে সার্চ — সব ডাক্তারের রোগীর মধ্যে।
 * নিরাপত্তা: সব সার্চে ঘণ্টাপ্রতি সীমা, অন্য ডাক্তারের রোগী পেলে আলাদা সীমা + অডিট লগ।
 */
export async function searchByCode(doctor: DoctorRow, rawCode: string, date?: string): Promise<SearchResultItem[]> {
  const code = normalizePatientCode(rawCode ?? "");
  if (!PATIENT_CODE_REGEX.test(code)) throw new HttpError(400, "invalid_code", "৬ অঙ্কের রোগী-কোড লিখুন।");
  const day = dateOrToday(date);

  await enforceRateLimit(`search:${doctor.id}`, 3600, 300, "এক ঘণ্টায় অনেকবার সার্চ করা হয়েছে। কিছুক্ষণ পর চেষ্টা করুন।");

  const rows = await q<VisitDbRow & { doctor_name: string }>(
    `select ${LIST_COLUMNS}, d.full_name as doctor_name
       from public.visits v
       join public.doctors d on d.id = v.doctor_id
       left join public.summaries s on s.visit_id = v.id
      where v.patient_code = $1 and v.visit_date = $2::date`,
    [code, day],
  );

  const others = rows.filter((r) => r.doctor_id !== doctor.id);
  if (others.length) {
    await enforceRateLimit(
      `xsearch:${doctor.id}`,
      3600,
      env.CROSS_DOCTOR_SEARCH_PER_HOUR,
      "অন্য ডাক্তারের রোগী দেখার ঘণ্টাপ্রতি সীমা পূর্ণ হয়েছে।",
    );
    for (const r of others) await audit(doctor.id, "cross_search_hit", r.id, { code, date: day, ownerDoctorId: r.doctor_id });
  }

  return rows.map((r) => ({ ...toListItem(r), doctorName: r.doctor_name, isOwn: r.doctor_id === doctor.id }));
}

async function assertCanView(doctor: DoctorRow, visitId: string, ownerId: string): Promise<boolean> {
  if (ownerId === doctor.id) return true;
  const ok = await q1(
    `select 1 from public.audit_logs
      where actor_id = $1 and visit_id = $2 and action = 'cross_search_hit'
        and created_at > now() - make_interval(hours => $3)
      limit 1`,
    [doctor.id, visitId, env.CROSS_DOCTOR_VIEW_WINDOW_HOURS],
  );
  if (!ok) throw forbidden("অন্য ডাক্তারের রোগী দেখতে আগে রোগী-কোড দিয়ে সার্চ করুন।");
  return false;
}

export async function getVisitDetail(doctor: DoctorRow, visitId: string): Promise<VisitDetail> {
  const v = await q1<VisitDbRow & { doctor_name: string; chamber_name: string | null; interview_state: { comorbidities?: string[] } | null }>(
    `select ${LIST_COLUMNS}, d.full_name as doctor_name, d.chamber_name, v.interview_state
       from public.visits v
       join public.doctors d on d.id = v.doctor_id
       left join public.summaries s on s.visit_id = v.id
      where v.id = $1`,
    [visitId],
  );
  if (!v) throw notFound("রোগীর তথ্য");
  const isOwn = await assertCanView(doctor, visitId, v.doctor_id);
  if (!isOwn) await audit(doctor.id, "cross_view", visitId, { ownerDoctorId: v.doctor_id });

  const [summaryRow, messages, uploads, alerts] = await Promise.all([
    q1<{ summary: SummaryCard; generated_by: "ai" | "rules"; model: string | null; created_at: string | Date }>(
      "select summary, generated_by, model, created_at from public.summaries where visit_id = $1",
      [visitId],
    ),
    q<{ id: string; role: "assistant" | "patient"; question_id: string | null; text_bn: string | null; stt_source: string | null; created_at: string | Date }>(
      "select id::text as id, role, question_id, text_bn, stt_source, created_at from public.messages where visit_id = $1 order by id",
      [visitId],
    ),
    q<{ id: string; kind: VisitUpload["kind"]; storage_path: string; deleted_at: string | null; created_at: string | Date }>(
      "select id, kind, storage_path, deleted_at, created_at from public.uploads where visit_id = $1 and submitted order by created_at",
      [visitId],
    ),
    q<{ id: string; level: "urgent" | "emergency"; rule_id: string; reason_bn: string | null; created_at: string | Date; acknowledged_at: string | Date | null }>(
      "select id, level, rule_id, reason_bn, created_at, acknowledged_at from public.alerts where visit_id = $1 order by created_at",
      [visitId],
    ),
  ]);

  const live = uploads.filter((u) => !u.deleted_at);
  const signed = new Map<string, string>();
  if (live.length) {
    const { data } = await storage().createSignedUrls(
      live.map((u) => u.storage_path),
      600,
    );
    for (const item of data ?? []) if (item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
  }

  return {
    visit: toListItem(v),
    doctor: { id: v.doctor_id, fullName: v.doctor_name, chamberName: v.chamber_name },
    isOwn,
    summary: summaryRow?.summary ?? null,
    summaryMeta: summaryRow
      ? { generatedBy: summaryRow.generated_by, model: summaryRow.model, createdAt: iso(summaryRow.created_at) }
      : null,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      questionId: m.question_id,
      textBn: m.text_bn,
      sttSource: m.stt_source,
      createdAt: iso(m.created_at),
    })),
    uploads: uploads.map((u) => ({
      id: u.id,
      kind: u.kind,
      url: u.deleted_at ? null : signed.get(u.storage_path) ?? null,
      deleted: !!u.deleted_at,
      createdAt: iso(u.created_at),
    })),
    alerts: alerts.map((a) => ({
      id: a.id,
      visitId,
      patientCode: v.patient_code,
      level: a.level,
      ruleId: a.rule_id,
      reasonBn: a.reason_bn,
      createdAt: iso(a.created_at),
      acknowledgedAt: a.acknowledged_at ? iso(a.acknowledged_at) : null,
    })),
    comorbidities: v.interview_state?.comorbidities ?? [],
  };
}

export async function markSeen(doctor: DoctorRow, visitId: string): Promise<void> {
  const v = await q1<{ doctor_id: string }>("select doctor_id from public.visits where id = $1", [visitId]);
  if (!v) throw notFound("রোগীর তথ্য");
  await assertCanView(doctor, visitId, v.doctor_id);
  await q(
    `update public.visits set status = 'seen', seen_at = now(), seen_by_doctor_id = $2
      where id = $1 and status <> 'seen'`,
    [visitId, doctor.id],
  );
  await audit(doctor.id, "mark_seen", visitId);
  await emitDoctorEvent(v.doctor_id, visitId, "visit_updated");
}

export async function listOpenAlerts(doctor: DoctorRow): Promise<AlertItem[]> {
  const rows = await q<{ id: string; visit_id: string; patient_code: string; level: "urgent" | "emergency"; rule_id: string; reason_bn: string | null; created_at: string | Date }>(
    `select a.id, a.visit_id, v.patient_code, a.level, a.rule_id, a.reason_bn, a.created_at
       from public.alerts a join public.visits v on v.id = a.visit_id
      where a.doctor_id = $1 and a.acknowledged_at is null and a.created_at > now() - interval '18 hours'
      order by (a.level = 'emergency') desc, a.created_at desc
      limit 50`,
    [doctor.id],
  );
  return rows.map((a) => ({
    id: a.id,
    visitId: a.visit_id,
    patientCode: a.patient_code,
    level: a.level,
    ruleId: a.rule_id,
    reasonBn: a.reason_bn,
    createdAt: iso(a.created_at),
    acknowledgedAt: null,
  }));
}

export async function ackAlert(doctor: DoctorRow, alertId: string): Promise<void> {
  const row = await q1(
    "update public.alerts set acknowledged_at = now() where id = $1 and doctor_id = $2 returning id",
    [alertId, doctor.id],
  );
  if (!row) throw notFound("অ্যালার্ট");
}

export async function setChamberOpen(doctor: DoctorRow, isOpen: boolean): Promise<void> {
  await q("update public.doctors set is_open = $2 where id = $1", [doctor.id, isOpen]);
  await audit(doctor.id, isOpen ? "chamber_open" : "chamber_close", null);
}

/** ডাক্তার নিজের প্রোফাইল (বিশেষজ্ঞতা, ডিগ্রি, চেম্বার) বদলান — নাম ও লিংক শুধু অ্যাডমিন বদলান */
export async function updateOwnProfile(doctor: DoctorRow, body: UpdateOwnProfileBody): Promise<void> {
  const clean = (s: string) => s.trim() || null;
  await q(
    `update public.doctors set specialty = $2, qualifications = $3, chamber_name = $4, chamber_address = $5 where id = $1`,
    [doctor.id, clean(body.specialty), clean(body.qualifications), clean(body.chamberName), clean(body.chamberAddress)],
  );
  await audit(doctor.id, "profile_updated", null);
}

export async function markPasswordChanged(doctor: DoctorRow): Promise<void> {
  await q("update public.doctors set must_change_password = false where id = $1", [doctor.id]);
}
