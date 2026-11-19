import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import {
  CONSENT_VERSION,
  COMORBIDITY_IDS,
  MAX_UPLOADS_PER_VISIT,
  PATIENT_MESSAGES_BN,
  truncate,
  type DoctorPublic,
  type Question,
  type RedFlagLevel,
  type RedFlagNotice,
  type RespondBody,
  type RespondResponse,
  type StartVisitBody,
  type StartVisitResponse,
  type Step,
  type UploadUrlBody,
  type UploadUrlResponse,
  type VisitStateResponse,
  type VisitStatus,
} from "@chamberai/shared";
import type { DoctorRow } from "../auth";
import { env } from "../config";
import { isUniqueViolation, q, q1 } from "../db";
import { HttpError, notFound } from "../errors";
import type { RedFlagHit } from "../clinical/redFlags";
import { newPatientCode, newSessionSecret, safeEqualHex, sha256 } from "../lib/crypto";
import { emitDoctorEvent } from "../lib/events";
import { maskPii } from "../lib/pii";
import { enforceRateLimit } from "../lib/rateLimit";
import { storage } from "../supabase";
import { chooseMode } from "../llm/quota";
import {
  deleteInterviewThread,
  getInterviewGraph,
  getSnapshot,
  threadConfig,
  type InterviewSnapshot,
} from "../graph/interviewGraph";
import { aiAllowedForNextTurn } from "../graph/nodes";
import { toStoredState, type AnswerPayload, type InterviewState } from "../graph/state";
import { enqueueSummary } from "./summary";
import { kickWorker } from "./worker";

interface VisitRow {
  id: string;
  doctor_id: string;
  patient_code: string;
  session_secret_hash: string;
  status: VisitStatus;
  ai_mode: string;
  red_flag_level: RedFlagLevel;
  created_at: string;
}

const CLOSED_STATUSES: VisitStatus[] = ["finishing", "completed", "seen", "abandoned"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function loadVisitForPatient(visitId: string, secret: string): Promise<VisitRow> {
  const v = await q1<VisitRow>(
    `select id, doctor_id, patient_code, session_secret_hash, status, ai_mode, red_flag_level, created_at
       from public.visits where id = $1`,
    [visitId],
  );
  if (!v || !safeEqualHex(sha256(secret), v.session_secret_hash)) {
    throw new HttpError(401, "invalid_session", "সেশন পাওয়া যায়নি। অনুগ্রহ করে QR আবার স্ক্যান করুন।");
  }
  if (Date.now() - new Date(v.created_at).getTime() > 18 * 3600 * 1000) {
    throw new HttpError(410, "session_expired", "এই সেশনের মেয়াদ শেষ। নতুন করে শুরু করুন।");
  }
  return v;
}

/** ভিজিট লোড + স্টেপ-লক একসাথে (এক round-trip)। লক শুধু সঠিক session secret হলেই নেওয়া হয়। */
async function loadVisitAndLock(visitId: string, secret: string): Promise<{ visit: VisitRow; locked: boolean }> {
  const row = await q1<VisitRow & { locked: boolean }>(
    `with l as (
       update public.visits set step_lock_until = now() + interval '90 seconds'
        where id = $1 and session_secret_hash = $2
          and (step_lock_until is null or step_lock_until < now())
        returning id)
     select v.id, v.doctor_id, v.patient_code, v.session_secret_hash, v.status, v.ai_mode, v.red_flag_level,
            v.created_at, exists(select 1 from l) as locked
       from public.visits v where v.id = $1`,
    [visitId, sha256(secret)],
  );
  if (!row || !safeEqualHex(sha256(secret), row.session_secret_hash)) {
    throw new HttpError(401, "invalid_session", "সেশন পাওয়া যায়নি। অনুগ্রহ করে QR আবার স্ক্যান করুন।");
  }
  if (Date.now() - new Date(row.created_at).getTime() > 18 * 3600 * 1000) {
    if (row.locked) await releaseLock(visitId);
    throw new HttpError(410, "session_expired", "এই সেশনের মেয়াদ শেষ। নতুন করে শুরু করুন।");
  }
  const { locked, ...visit } = row;
  return { visit, locked };
}

async function releaseLock(visitId: string): Promise<void> {
  await q("update public.visits set step_lock_until = null where id = $1", [visitId]).catch(() => undefined);
}

function stepFromSnapshot(snap: InterviewSnapshot): Step {
  const p = snap.pending;
  if (!p) return { type: "done" };
  if (p.type === "question") {
    const question: Question = { ...p.question, audioAllowed: aiAllowedForNextTurn(snap.values) };
    return { type: "question", question };
  }
  return p.type === "comorbidities" ? { type: "comorbidities" } : { type: "photos" };
}

function noticeFor(level: RedFlagLevel, hits: RedFlagHit[] = []): RedFlagNotice | null {
  if (level === "none") return null;
  const special = hits.find((h) => h.level === level && h.patientMessageBn !== PATIENT_MESSAGES_BN[level]);
  return { level, messageBn: special?.patientMessageBn ?? PATIENT_MESSAGES_BN[level] };
}

async function persistAssistantQuestion(visitId: string, step: Step): Promise<void> {
  if (step.type !== "question") return;
  // একই প্রশ্ন দুবার না লেখা — চেক ও ইনসার্ট এক কুয়েরিতে (DB round-trip কমাতে)
  await q(
    `insert into public.messages (visit_id, role, question_id, text_bn)
     select $1, 'assistant', $2, $3
      where coalesce((select m.question_id from public.messages m
                       where m.visit_id = $1 and m.role = 'assistant'
                       order by m.id desc limit 1), '') <> $2`,
    [visitId, step.question.id, step.question.textBn],
  );
}

async function persistAlerts(visit: VisitRow, hits: RedFlagHit[]): Promise<void> {
  for (const h of hits) {
    const ins = await q1<{ id: string }>(
      `insert into public.alerts (visit_id, doctor_id, level, rule_id, reason_bn) values ($1, $2, $3, $4, $5)
       on conflict (visit_id, rule_id) do nothing returning id`,
      [visit.id, visit.doctor_id, h.level, h.ruleId, h.reasonBn],
    );
    if (ins) await emitDoctorEvent(visit.doctor_id, visit.id, "alert");
  }
}

async function finalizeInterview(visit: VisitRow, values: InterviewState): Promise<void> {
  await q(
    `update public.visits set status = 'finishing', interview_state = $2
      where id = $1 and status in ('started', 'interviewing')`,
    [visit.id, JSON.stringify(toStoredState(values))],
  );
  await enqueueSummary(visit.id);
  kickWorker();
  // checkpoint আর লাগবে না — রেসপন্স আটকে না রেখে ব্যাকগ্রাউন্ডে মুছি (ব্যর্থ হলে cleanup cron মুছবে)
  void deleteInterviewThread(visit.id).catch((err) => console.error("[interview] deleteThread failed", err));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function getDoctorPublic(slug: string): Promise<DoctorPublic> {
  const d = await q1<DoctorRow>("select * from public.doctors where slug = $1", [slug.toLowerCase()]);
  if (!d || !d.is_active) throw notFound("ডাক্তার");
  return {
    fullName: d.full_name,
    specialty: d.specialty,
    qualifications: d.qualifications ?? null,
    chamberName: d.chamber_name,
    chamberAddress: d.chamber_address,
    isOpen: d.is_open,
  };
}

export async function startVisit(body: StartVisitBody, clientIpHash: string): Promise<StartVisitResponse> {
  const doctor = await q1<DoctorRow>("select * from public.doctors where slug = $1", [body.slug.toLowerCase()]);
  if (!doctor || !doctor.is_active) throw notFound("ডাক্তার");
  if (!doctor.is_open) {
    throw new HttpError(403, "chamber_closed", "এই মুহূর্তে ডাক্তারের AI সহকারী চালু নেই। চেম্বারের সহকারীর সাথে কথা বলুন।");
  }
  if (body.consentVersion !== CONSENT_VERSION) {
    throw new HttpError(409, "consent_outdated", "সম্মতিপত্র হালনাগাদ হয়েছে — পেজটি রিফ্রেশ করুন।");
  }
  await enforceRateLimit(
    `visit_start:${clientIpHash}`,
    3600,
    env.MAX_NEW_VISITS_PER_IP_PER_HOUR,
    "এই ডিভাইস থেকে অনেকগুলো ইন্টারভিউ শুরু হয়েছে। কিছুক্ষণ পর চেষ্টা করুন।",
  );

  const mode = await chooseMode(doctor.id, doctor.daily_ai_limit);
  const secret = newSessionSecret();

  let visit: VisitRow | null = null;
  for (let i = 0; i < 8 && !visit; i++) {
    try {
      visit = await q1<VisitRow>(
        `insert into public.visits
           (doctor_id, patient_code, session_secret_hash, age_years, sex, ai_mode, consent_version, client_ip_hash, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'interviewing')
         returning id, doctor_id, patient_code, session_secret_hash, status, ai_mode, red_flag_level, created_at`,
        [doctor.id, newPatientCode(), secret.hash, body.ageYears, body.sex, mode, body.consentVersion, clientIpHash],
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!visit) throw new HttpError(503, "code_unavailable", "এই মুহূর্তে কোড তৈরি করা যাচ্ছে না। আবার চেষ্টা করুন।");

  const graph = await getInterviewGraph();
  await graph.invoke(
    { visitId: visit.id, doctorId: doctor.id, mode, ageYears: body.ageYears, sex: body.sex },
    // "exit": শুধু interrupt/শেষে checkpoint লেখা হয় — প্রতিটি নোডে DB-তে লেখা লাগে না
    { ...threadConfig(visit.id), durability: "exit" as const },
  );
  const step = stepFromSnapshot(await getSnapshot(graph, visit.id));
  await Promise.all([
    persistAssistantQuestion(visit.id, step),
    emitDoctorEvent(doctor.id, visit.id, "visit_created"),
  ]);

  return { visitId: visit.id, patientCode: visit.patient_code, sessionSecret: secret.raw, step };
}

export async function getVisitState(visitId: string, secret: string): Promise<VisitStateResponse> {
  const visit = await loadVisitForPatient(visitId, secret);
  const redFlag = noticeFor(visit.red_flag_level);
  if (CLOSED_STATUSES.includes(visit.status)) {
    return { visitId, patientCode: visit.patient_code, status: visit.status, step: { type: "done" }, redFlag };
  }
  const graph = await getInterviewGraph();
  const snap = await getSnapshot(graph, visitId);
  return { visitId, patientCode: visit.patient_code, status: visit.status, step: stepFromSnapshot(snap), redFlag };
}

export async function respond(visitId: string, secret: string, body: RespondBody): Promise<RespondResponse> {
  const { visit, locked } = await loadVisitAndLock(visitId, secret);
  if (CLOSED_STATUSES.includes(visit.status)) {
    if (locked) await releaseLock(visitId);
    return { step: { type: "done" }, transcriptBn: null, redFlag: null };
  }
  if (!locked) {
    throw new HttpError(409, "busy", "আগের উত্তরটি প্রসেস হচ্ছে, একটু অপেক্ষা করুন।");
  }

  let lockReleased = false;
  try {
    const graph = await getInterviewGraph();
    const before = await getSnapshot(graph, visitId);
    const currentStep = stepFromSnapshot(before);

    if (!before.pending) {
      if (before.finished) await finalizeInterview(visit, before.values);
      return { step: { type: "done" }, transcriptBn: null, redFlag: null };
    }
    // রোগীর ফোনে যে ধাপ দেখানো হচ্ছিল, উত্তর সেই ধাপেরই কিনা (পুরনো ট্যাব/ডাবল-ক্লিক ঠেকাতে)
    const expectedBodyType = before.pending.type === "question" ? "answer" : before.pending.type;
    if (expectedBodyType !== body.type) {
      throw new HttpError(409, "step_mismatch", "ধাপটি বদলে গেছে — পেজটি হালনাগাদ হচ্ছে।", { step: currentStep });
    }

    const alertsBefore = new Set(before.values.alerts.map((a) => a.ruleId));
    let resume: unknown;
    let audio: { b64: string; mimeType: string } | undefined;
    let patientMessageId: string | null = null;

    if (body.type === "answer") {
      if (before.pending.type !== "question" || before.pending.question.id !== body.questionId) {
        throw new HttpError(409, "step_mismatch", "প্রশ্নটি বদলে গেছে — পেজটি হালনাগাদ হচ্ছে।", { step: currentStep });
      }
      const text = maskPii((body.text ?? "").trim());
      const hasAudio = !!body.audioB64;
      if (!text && !hasAudio) throw new HttpError(400, "empty_answer", "অনুগ্রহ করে উত্তরটি বলুন বা লিখুন।");
      const audioOk = aiAllowedForNextTurn(before.values);
      if (!text && hasAudio && !audioOk) {
        throw new HttpError(422, "audio_unavailable", "এই মুহূর্তে ভয়েস-উত্তর বোঝা যাচ্ছে না — অনুগ্রহ করে লিখে দিন।");
      }
      const msg = await q1<{ id: string }>(
        `insert into public.messages (visit_id, role, question_id, text_bn, stt_source)
         values ($1, 'patient', $2, $3, $4) returning id::text as id`,
        [visitId, body.questionId, text || "(অডিও উত্তর)", body.sttSource],
      );
      patientMessageId = msg!.id;
      const payload: AnswerPayload = {
        kind: "answer",
        questionId: body.questionId,
        text,
        sttSource: body.sttSource,
        messageId: patientMessageId,
      };
      resume = payload;
      if (hasAudio && !text && audioOk) audio = { b64: body.audioB64!, mimeType: body.mimeType ?? "audio/webm" };
    } else if (body.type === "comorbidities") {
      resume = body.items.filter((i) => COMORBIDITY_IDS.includes(i));
    } else {
      const ids = body.uploadIds.length
        ? (
            await q<{ id: string }>("select id from public.uploads where visit_id = $1 and id = any($2::uuid[])", [
              visitId,
              body.uploadIds,
            ])
          ).map((r) => r.id)
        : [];
      if (ids.length) await q("update public.uploads set submitted = true where id = any($1::uuid[])", [ids]);
      resume = ids;
    }

    await graph.invoke(new Command({ resume }), {
      ...threadConfig(visitId, audio ? { audio } : {}),
      durability: "exit" as const,
    });
    const after = await getSnapshot(graph, visitId);
    const values = after.values;

    // অডিও থেকে পাওয়া লেখা মেসেজে বসানো
    let transcriptBn: string | null = null;
    if (patientMessageId) {
      const entry = [...values.transcript].reverse().find((t) => t.role === "patient" && t.messageId === patientMessageId);
      if (entry && audio) {
        transcriptBn = entry.text;
        await q("update public.messages set text_bn = $2 where id = $1", [patientMessageId, maskPii(entry.text)]);
      }
    }

    const newAlerts = values.alerts.filter((a) => !alertsBefore.has(a.ruleId));
    const step = stepFromSnapshot(after);

    // স্বাধীন লেখাগুলো একসাথে (প্রতিটি DB round-trip-এ সময় লাগে); ভিজিট-আপডেটের সাথেই লক ছাড়া হয়
    await Promise.all([
      persistAlerts(visit, newAlerts),
      q(
        `update public.visits set category = $2, chief_complaint_short = $3, red_flag_level = $4, ai_mode = $5,
                step_lock_until = null
          where id = $1`,
        [
          visitId,
          values.category,
          values.chiefComplaint?.bn ? truncate(values.chiefComplaint.bn, 120) : null,
          values.redFlagLevel,
          values.mode,
        ],
      ).then(() => {
        lockReleased = true;
      }),
      step.type === "question" ? persistAssistantQuestion(visitId, step) : Promise.resolve(),
    ]);
    if (step.type === "done") await finalizeInterview(visit, values);
    await emitDoctorEvent(visit.doctor_id, visitId, "visit_updated");

    const redFlag = newAlerts.length ? noticeFor(values.redFlagLevel, newAlerts) : null;
    return { step, transcriptBn, redFlag };
  } finally {
    if (!lockReleased) await releaseLock(visitId);
  }
}

export async function createUploadUrl(visitId: string, secret: string, body: UploadUrlBody): Promise<UploadUrlResponse> {
  const visit = await loadVisitForPatient(visitId, secret);
  if (CLOSED_STATUSES.includes(visit.status)) throw new HttpError(409, "visit_closed", "ইন্টারভিউ শেষ হয়ে গেছে।");
  const count = await q1<{ n: number }>("select count(*)::int as n from public.uploads where visit_id = $1", [visitId]);
  if ((count?.n ?? 0) >= MAX_UPLOADS_PER_VISIT) {
    throw new HttpError(400, "too_many_uploads", `সর্বোচ্চ ${MAX_UPLOADS_PER_VISIT}টি ছবি দেওয়া যায়।`);
  }

  const ext = body.contentType === "image/png" ? "png" : body.contentType === "image/webp" ? "webp" : "jpg";
  const id = randomUUID();
  const path = `${visit.doctor_id}/${visitId}/${id}.${ext}`;
  const { data, error } = await storage().createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(502, "storage_error", "ছবি আপলোডের ব্যবস্থা করা যায়নি। আবার চেষ্টা করুন।");

  await q(
    "insert into public.uploads (id, visit_id, kind, storage_path, content_type) values ($1, $2, $3, $4, $5)",
    [id, visitId, body.kind, path, body.contentType],
  );
  return { uploadId: id, bucket: env.STORAGE_BUCKET, path: data.path ?? path, token: data.token, signedUrl: data.signedUrl };
}
