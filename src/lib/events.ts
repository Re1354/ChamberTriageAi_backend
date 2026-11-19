import { q } from "../db";

export type DoctorEventKind = "visit_created" | "visit_updated" | "summary_ready" | "alert";

/** ডাক্তারের ড্যাশবোর্ডকে রিয়েল-টাইমে জানানো (Supabase Realtime → doctor_events) */
export async function emitDoctorEvent(doctorId: string, visitId: string | null, kind: DoctorEventKind) {
  await q("insert into public.doctor_events (doctor_id, visit_id, kind) values ($1, $2, $3)", [doctorId, visitId, kind]).catch(
    (err) => console.warn("[events] failed", err.message),
  );
}

export async function audit(actorId: string | null, action: string, visitId: string | null, meta?: Record<string, unknown>) {
  await q("insert into public.audit_logs (actor_id, action, visit_id, meta) values ($1, $2, $3, $4)", [
    actorId,
    action,
    visitId,
    meta ? JSON.stringify(meta) : null,
  ]).catch((err) => console.warn("[audit] failed", err.message));
}
