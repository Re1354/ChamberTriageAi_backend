-- LangGraph checkpoint টেবিল (API প্রথমবার চালু হলে তৈরি হয়) — ব্রাউজার/Data API থেকে বন্ধ রাখা।
-- API নিজেও চালু হওয়ার সময় এটা করে; এই মাইগ্রেশন আগে-থেকে-থাকা টেবিলের জন্য।
do $$
declare t text;
begin
  foreach t in array array['checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- ভবিষ্যতে public-এ নতুন টেবিল হলে anon/authenticated স্বয়ংক্রিয় অনুমতি না পায়
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
