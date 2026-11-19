-- ডাক্তারের ডিগ্রি/যোগ্যতা (যেমন "MBBS (DMC), FCPS (মেডিসিন)") — রোগীর পেজ, QR পোস্টার ও ড্যাশবোর্ডে দেখায়
alter table public.doctors add column if not exists qualifications text
  check (qualifications is null or char_length(qualifications) <= 240);

-- রিটার্ন-টাইপ বদলাচ্ছে, তাই আগে drop
drop function if exists public.get_doctor_public(text);
create function public.get_doctor_public(p_slug text)
returns table (full_name text, specialty text, qualifications text, chamber_name text, chamber_address text, is_open boolean)
language sql stable security definer set search_path = public as $$
  select full_name, specialty, qualifications, chamber_name, chamber_address, (is_open and is_active)
    from public.doctors
   where slug = lower(p_slug);
$$;
revoke execute on function public.get_doctor_public(text) from public;
grant execute on function public.get_doctor_public(text) to anon, authenticated;
