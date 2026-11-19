-- ============================================================================
-- ChamberTriage AI — initial schema
-- Supabase SQL Editor-এ পুরো ফাইলটা একবারে চালান।
--
-- নিরাপত্তা-নকশা:
--   * সব টেবিলে RLS চালু। ব্রাউজার (anon/authenticated) সরাসরি কোনো টেবিল পড়তে/লিখতে পারে না,
--     শুধু doctor_events (নিজের) — রিয়েল-টাইম নোটিফিকেশনের জন্য।
--   * সব ডেটা-অ্যাক্সেস ব্যাকএন্ড (service role) দিয়ে, যেখানে ডাক্তার-ভিত্তিক অনুমতি,
--     ক্রস-ডাক্তার সার্চের সীমা ও অডিট লগ প্রয়োগ হয়।
-- ============================================================================

create extension if not exists pg_trgm;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Admins & doctors
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.doctors (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text not null,
  full_name            text not null,
  specialty            text,
  chamber_name         text,
  chamber_address      text,
  slug                 text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  is_open              boolean not null default false,
  is_active            boolean not null default true,
  daily_ai_limit       int not null default 80 check (daily_ai_limit >= 0),
  must_change_password boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger doctors_updated_at before update on public.doctors
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Visits: একটি AI ইন্টারভিউ = একটি visit = একটি LangGraph thread
-- patient_code: ৬ অঙ্ক, একই দিনে সব ডাক্তার মিলিয়ে অনন্য (ক্রস-ডাক্তার সার্চের জন্য)
-- ---------------------------------------------------------------------------
create table public.visits (
  id                    uuid primary key default gen_random_uuid(),
  doctor_id             uuid not null references public.doctors(id) on delete cascade,
  visit_date            date not null default ((now() at time zone 'Asia/Dhaka')::date),
  patient_code          text not null check (patient_code ~ '^[0-9]{6}$'),
  session_secret_hash   text not null,
  age_years             int check (age_years between 0 and 120),
  sex                   text check (sex in ('male', 'female', 'other')),
  status                text not null default 'started'
                          check (status in ('started', 'interviewing', 'finishing', 'completed', 'seen', 'abandoned')),
  ai_mode               text not null default 'standard'
                          check (ai_mode in ('standard', 'lean', 'economy', 'no_ai')),
  red_flag_level        text not null default 'none' check (red_flag_level in ('none', 'urgent', 'emergency')),
  category              text,
  chief_complaint_short text,
  interview_state       jsonb,
  consent_version       text not null,
  consent_at            timestamptz not null default now(),
  client_ip_hash        text,
  step_lock_until       timestamptz,
  seen_by_doctor_id     uuid references public.doctors(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  completed_at          timestamptz,
  seen_at               timestamptz
);
create unique index visits_day_code_uidx on public.visits (visit_date, patient_code);
create index visits_doctor_day_idx on public.visits (doctor_id, visit_date, created_at desc);
create index visits_status_idx on public.visits (status, created_at);
create trigger visits_updated_at before update on public.visits
  for each row execute function public.set_updated_at();

create table public.messages (
  id                bigserial primary key,
  visit_id          uuid not null references public.visits(id) on delete cascade,
  role              text not null check (role in ('assistant', 'patient')),
  question_id       text,
  text_bn           text,
  stt_source        text check (stt_source in ('web_speech', 'typed', 'audio')),
  created_at        timestamptz not null default now()
);
create index messages_visit_idx on public.messages (visit_id, id);

create table public.uploads (
  id                uuid primary key default gen_random_uuid(),
  visit_id          uuid not null references public.visits(id) on delete cascade,
  kind              text not null check (kind in ('medicine', 'lab_report', 'prescription', 'other')),
  storage_path      text not null,
  content_type      text,
  submitted         boolean not null default false,
  extracted         jsonb,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index uploads_visit_idx on public.uploads (visit_id);
create index uploads_cleanup_idx on public.uploads (created_at) where deleted_at is null;

create table public.summaries (
  visit_id          uuid primary key references public.visits(id) on delete cascade,
  summary           jsonb not null,
  generated_by      text not null check (generated_by in ('ai', 'rules')),
  verify_ok         boolean not null default false,
  model             text,
  prompt_version    text,
  tokens_in         int,
  tokens_out        int,
  latency_ms        int,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger summaries_updated_at before update on public.summaries
  for each row execute function public.set_updated_at();

create table public.alerts (
  id                uuid primary key default gen_random_uuid(),
  visit_id          uuid not null references public.visits(id) on delete cascade,
  doctor_id         uuid not null references public.doctors(id) on delete cascade,
  level             text not null check (level in ('urgent', 'emergency')),
  rule_id           text not null,
  reason_bn         text,
  acknowledged_at   timestamptz,
  created_at        timestamptz not null default now(),
  unique (visit_id, rule_id)
);
create index alerts_doctor_open_idx on public.alerts (doctor_id, created_at desc) where acknowledged_at is null;

-- রিয়েল-টাইম নোটিফিকেশন: ডাক্তার নিজের ইভেন্ট শোনেন, তারপর API থেকে আবার লোড করেন।
-- (visits টেবিল সরাসরি Realtime-এ দেওয়া হয়নি, যাতে কোনো গোপন কলাম ব্রাউজারে না যায়।)
create table public.doctor_events (
  id                bigserial primary key,
  doctor_id         uuid not null references public.doctors(id) on delete cascade,
  visit_id          uuid references public.visits(id) on delete cascade,
  kind              text not null check (kind in ('visit_created', 'visit_updated', 'summary_ready', 'alert')),
  created_at        timestamptz not null default now()
);
create index doctor_events_doctor_idx on public.doctor_events (doctor_id, id desc);

-- ---------------------------------------------------------------------------
-- AI usage (কোটা গোনা — Gemini-র দৈনিক কোটা প্যাসিফিক মধ্যরাতে রিসেট হয়)
-- ---------------------------------------------------------------------------
create table public.llm_usage (
  id                bigserial primary key,
  quota_day         date not null default ((now() at time zone 'America/Los_Angeles')::date),
  model             text not null,
  purpose           text not null check (purpose in ('turn', 'final', 'embed', 'eval', 'other')),
  doctor_id         uuid,
  visit_id          uuid,
  ok                boolean not null,
  error_code        text,
  tokens_in         int,
  tokens_out        int,
  latency_ms        int,
  created_at        timestamptz not null default now()
);
create index llm_usage_day_model_idx on public.llm_usage (quota_day, model) where ok;
create index llm_usage_visit_idx on public.llm_usage (visit_id);

-- ---------------------------------------------------------------------------
-- Audit log (ক্রস-ডাক্তার সার্চ ও দেখা সব লগ হয়)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id                bigserial primary key,
  actor_id          uuid,
  action            text not null,
  visit_id          uuid,
  meta              jsonb,
  created_at        timestamptz not null default now()
);
create index audit_actor_action_idx on public.audit_logs (actor_id, action, created_at desc);
create index audit_visit_idx on public.audit_logs (visit_id);

-- ---------------------------------------------------------------------------
-- Rate limits (একাধিক সার্ভার-ইনস্ট্যান্সেও কাজ করে)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key               text not null,
  window_start      timestamptz not null,
  count             int not null default 0,
  primary key (key, window_start)
);

create or replace function public.hit_rate_limit(p_key text, p_window_seconds int, p_max int)
returns boolean language plpgsql as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count  int;
begin
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  return v_count <= p_max;
end $$;

-- ---------------------------------------------------------------------------
-- Job queue (সামারি তৈরি) — FOR UPDATE SKIP LOCKED, একাধিক ইনস্ট্যান্সে নিরাপদ
-- ---------------------------------------------------------------------------
create table public.jobs (
  id                bigserial primary key,
  type              text not null,
  dedupe_key        text,
  payload           jsonb not null default '{}'::jsonb,
  status            text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts          int not null default 0,
  run_after         timestamptz not null default now(),
  locked_at         timestamptz,
  finished_at       timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  unique (type, dedupe_key)
);
create index jobs_ready_idx on public.jobs (status, run_after);

create or replace function public.claim_job(p_types text[])
returns setof public.jobs language sql as $$
  update public.jobs j
     set status = 'running', locked_at = now(), attempts = j.attempts + 1
   where j.id = (
     select id from public.jobs
      where type = any(p_types)
        and ((status = 'queued' and run_after <= now())
          or (status = 'running' and locked_at < now() - interval '5 minutes'))
      order by created_at
      for update skip locked
      limit 1)
  returning j.*;
$$;

-- ---------------------------------------------------------------------------
-- Knowledge base (RAG)
-- ---------------------------------------------------------------------------
create table public.kb_drugs (
  id                uuid primary key default gen_random_uuid(),
  brand_name        text not null,
  generic_name      text not null,
  strength          text,
  dosage_form       text,
  manufacturer      text,
  drug_class        text,
  search_text       text not null,
  embedding         vector(768),
  unique (brand_name, generic_name, strength)
);
create index kb_drugs_trgm_idx on public.kb_drugs using gin (search_text gin_trgm_ops);
create index kb_drugs_brand_trgm_idx on public.kb_drugs using gin (brand_name gin_trgm_ops);
create index kb_drugs_fts_idx on public.kb_drugs using gin (to_tsvector('simple', search_text));
create index kb_drugs_vec_idx on public.kb_drugs using hnsw (embedding vector_cosine_ops);

create table public.kb_symptoms (
  id                uuid primary key default gen_random_uuid(),
  term_bn           text not null unique,
  variants          text[] not null default '{}',
  term_en           text,
  category          text,
  icd11_code        text,
  search_text       text not null,
  embedding         vector(768)
);
create index kb_symptoms_trgm_idx on public.kb_symptoms using gin (search_text gin_trgm_ops);
create index kb_symptoms_vec_idx on public.kb_symptoms using hnsw (embedding vector_cosine_ops);

-- Hybrid search: trigram + full-text + (ঐচ্ছিক) vector, Reciprocal Rank Fusion দিয়ে মেলানো
create or replace function public.search_drugs(
  p_query text,
  p_embedding vector(768) default null,
  p_limit int default 5
) returns table (id uuid, brand_name text, generic_name text, strength text, drug_class text, score double precision)
language sql stable as $$
  with trg as (
    select d.id, row_number() over (order by similarity(d.search_text, p_query) desc) as r
      from public.kb_drugs d
     where d.search_text % p_query or d.search_text ilike '%' || p_query || '%'
     order by r limit 20
  ),
  fts as (
    select d.id, row_number() over (
             order by ts_rank(to_tsvector('simple', d.search_text), plainto_tsquery('simple', p_query)) desc) as r
      from public.kb_drugs d
     where to_tsvector('simple', d.search_text) @@ plainto_tsquery('simple', p_query)
     order by r limit 20
  ),
  vec as (
    select d.id, row_number() over (order by d.embedding <=> p_embedding) as r
      from public.kb_drugs d
     where p_embedding is not null and d.embedding is not null
     order by d.embedding <=> p_embedding limit 20
  ),
  fused as (
    select u.id, sum(1.0 / (60 + u.r)) as score
      from (select * from trg union all select * from fts union all select * from vec) u
     group by u.id
  )
  select d.id, d.brand_name, d.generic_name, d.strength, d.drug_class, f.score::double precision
    from fused f join public.kb_drugs d on d.id = f.id
   order by f.score desc
   limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Public RPC: রোগীর ল্যান্ডিং পেজ লগইন ছাড়াই ডাক্তারের নাম দেখাবে (Render ঘুমিয়ে থাকলেও)
-- ---------------------------------------------------------------------------
create or replace function public.get_doctor_public(p_slug text)
returns table (full_name text, specialty text, chamber_name text, chamber_address text, is_open boolean)
language sql stable security definer set search_path = public as $$
  select full_name, specialty, chamber_name, chamber_address, (is_open and is_active)
    from public.doctors
   where slug = lower(p_slug);
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.admins        enable row level security;
alter table public.doctors       enable row level security;
alter table public.visits        enable row level security;
alter table public.messages      enable row level security;
alter table public.uploads       enable row level security;
alter table public.summaries     enable row level security;
alter table public.alerts        enable row level security;
alter table public.doctor_events enable row level security;
alter table public.llm_usage     enable row level security;
alter table public.audit_logs    enable row level security;
alter table public.rate_limits   enable row level security;
alter table public.jobs          enable row level security;
alter table public.kb_drugs      enable row level security;
alter table public.kb_symptoms   enable row level security;

-- একমাত্র ব্রাউজার-পলিসি: ডাক্তার শুধু নিজের ইভেন্ট দেখেন (Realtime)
create policy doctor_reads_own_events on public.doctor_events
  for select to authenticated using (doctor_id = auth.uid());

-- ফাংশনের অনুমতি
revoke execute on function public.hit_rate_limit(text, int, int) from public, anon, authenticated;
revoke execute on function public.claim_job(text[]) from public, anon, authenticated;
revoke execute on function public.search_drugs(text, vector, int) from public, anon, authenticated;
revoke execute on function public.get_doctor_public(text) from public;
grant execute on function public.get_doctor_public(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.doctor_events;

-- ---------------------------------------------------------------------------
-- Storage bucket (private) — শুধু ব্যাকএন্ডের signed URL দিয়ে ব্যবহার
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visit-media', 'visit-media', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
