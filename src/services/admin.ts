import type { AdminDoctorRow, CreateDoctorBody, UsageResponse } from "@chamberai/shared";
import { z } from "zod";
import { toDoctorProfile, type DoctorRow } from "../auth";
import { env } from "../config";
import { q, q1 } from "../db";
import { HttpError, notFound } from "../errors";
import { audit } from "../lib/events";
import { dailyBudget, quotaDay, remaining } from "../llm/quota";
import { supabaseAdmin } from "../supabase";
import type { UpdateDoctorBodySchema } from "@chamberai/shared";

type UpdateDoctorBody = z.infer<typeof UpdateDoctorBodySchema>;

export async function listDoctors(): Promise<AdminDoctorRow[]> {
  const rows = await q<DoctorRow & { visits_today: number }>(
    `select d.*, (select count(*)::int from public.visits v
                   where v.doctor_id = d.id and v.visit_date = (now() at time zone 'Asia/Dhaka')::date) as visits_today
       from public.doctors d order by d.created_at desc`,
  );
  return rows.map((r) => ({
    ...toDoctorProfile(r),
    createdAt: new Date(r.created_at).toISOString(),
    visitsToday: r.visits_today,
  }));
}

/** নতুন ডাক্তার: Supabase Auth-এ অ্যাকাউন্ট (ইমেইল-কনফার্মেশন ছাড়া — ফ্রি ইমেইল-সীমায় আটকায় না) + doctors সারি */
export async function createDoctor(actorId: string, body: CreateDoctorBody): Promise<AdminDoctorRow> {
  const slugTaken = await q1("select 1 from public.doctors where slug = $1", [body.slug]);
  if (slugTaken) throw new HttpError(409, "slug_taken", "এই লিংক-নাম (slug) আগেই ব্যবহার হয়েছে।");

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    app_metadata: { role: "doctor" },
  });
  if (error || !data.user) {
    const msg = /already|registered|exists/i.test(error?.message ?? "")
      ? "এই ইমেইলে আগেই একটি অ্যাকাউন্ট আছে।"
      : "অ্যাকাউন্ট তৈরি করা যায়নি।";
    throw new HttpError(400, "auth_error", msg);
  }

  try {
    await q(
      `insert into public.doctors (id, email, full_name, specialty, chamber_name, chamber_address, slug, daily_ai_limit)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        data.user.id,
        body.email.toLowerCase(),
        body.fullName,
        body.specialty || null,
        body.chamberName || null,
        body.chamberAddress || null,
        body.slug,
        body.dailyAiLimit ?? 80,
      ],
    );
  } catch (err) {
    await supabaseAdmin.auth.admin.deleteUser(data.user.id).catch(() => undefined);
    throw err;
  }
  await audit(actorId, "doctor_created", null, { doctorId: data.user.id, slug: body.slug });
  const all = await listDoctors();
  return all.find((d) => d.id === data.user!.id)!;
}

export async function resetDoctorPassword(actorId: string, doctorId: string, password: string): Promise<void> {
  const d = await q1("select 1 from public.doctors where id = $1", [doctorId]);
  if (!d) throw notFound("ডাক্তার");
  const { error } = await supabaseAdmin.auth.admin.updateUserById(doctorId, { password });
  if (error) throw new HttpError(400, "auth_error", "পাসওয়ার্ড বদলানো যায়নি।");
  await q("update public.doctors set must_change_password = true where id = $1", [doctorId]);
  await audit(actorId, "doctor_password_reset", null, { doctorId });
}

export async function updateDoctor(actorId: string, doctorId: string, body: UpdateDoctorBody): Promise<void> {
  const d = await q1<DoctorRow>("select * from public.doctors where id = $1", [doctorId]);
  if (!d) throw notFound("ডাক্তার");
  await q(
    `update public.doctors set
       is_active = coalesce($2, is_active),
       daily_ai_limit = coalesce($3, daily_ai_limit),
       full_name = coalesce($4, full_name),
       specialty = coalesce($5, specialty),
       chamber_name = coalesce($6, chamber_name),
       chamber_address = coalesce($7, chamber_address),
       is_open = case when $2 = false then false else is_open end
     where id = $1`,
    [
      doctorId,
      body.isActive ?? null,
      body.dailyAiLimit ?? null,
      body.fullName ?? null,
      body.specialty ?? null,
      body.chamberName ?? null,
      body.chamberAddress ?? null,
    ],
  );
  // নিষ্ক্রিয় করলে লগইনও বন্ধ
  if (body.isActive !== undefined && body.isActive !== d.is_active) {
    await supabaseAdmin.auth.admin
      .updateUserById(doctorId, { ban_duration: body.isActive ? "none" : "876000h" })
      .catch(() => undefined);
  }
  await audit(actorId, "doctor_updated", null, { doctorId, ...body });
}

export async function usage(): Promise<UsageResponse> {
  const day = quotaDay();
  const models = await q<{ model: string; purpose: string; calls: number; failed: number; tokens_in: number; tokens_out: number }>(
    `select model, purpose,
            count(*) filter (where ok)::int as calls,
            count(*) filter (where not ok)::int as failed,
            coalesce(sum(tokens_in), 0)::int as tokens_in,
            coalesce(sum(tokens_out), 0)::int as tokens_out
       from public.llm_usage where quota_day = $1::date
      group by model, purpose order by model, purpose`,
    [day],
  );
  const visits = await q<{ mode: UsageResponse["visitsToday"][number]["mode"]; count: number }>(
    `select ai_mode as mode, count(*)::int as count from public.visits
      where visit_date = (now() at time zone 'Asia/Dhaka')::date group by ai_mode`,
  );
  return {
    quotaDay: day,
    models: models.map((m) => ({
      model: m.model,
      purpose: m.purpose,
      calls: m.calls,
      failed: m.failed,
      tokensIn: m.tokens_in,
      tokensOut: m.tokens_out,
    })),
    dailyLimits: { turn: dailyBudget("turn"), final: dailyBudget("final") },
    remaining: {
      turn: env.MOCK_LLM ? dailyBudget("turn") : await remaining("turn"),
      final: env.MOCK_LLM ? dailyBudget("final") : await remaining("final"),
    },
    visitsToday: visits,
  };
}
