-- Render-এর ফ্রি সার্ভার ১৫ মিনিট কোনো রিকোয়েস্ট না পেলে ঘুমিয়ে যায়; তখন প্রথম রোগীকে ~১ মিনিট অপেক্ষা করতে হয়
-- এবং অনেক সময় "সার্ভারে সংযোগ হচ্ছে না" দেখায়। এই জব Supabase থেকেই প্রতি ১০ মিনিটে /health?db=1 ডাকে:
--   • Render সার্ভার সবসময় জেগে থাকে (একটি সার্ভিস ২৪/৭ ≈ ৭৪৪ ঘণ্টা — Render ফ্রি-র ৭৫০ ঘণ্টার মধ্যে)
--   • Supabase প্রজেক্টও "inactive" হয়ে পজ হয় না
-- বন্ধ করতে: select cron.unschedule('keep-render-awake');
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'keep-render-awake';

select cron.schedule(
  'keep-render-awake',
  '*/10 * * * *',
  $$ select net.http_get(
       url := 'https://chambertriageai-backend.onrender.com/health?db=1',
       timeout_milliseconds := 60000
     ) $$
);
