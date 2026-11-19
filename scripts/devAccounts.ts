/**
 * লোকাল টেস্টের জন্য ডেমো অ্যাকাউন্ট (১ অ্যাডমিন + ২ ডাক্তার) তৈরি করে।
 *   npm run dev-accounts -w @chamberai/api
 * পাসওয়ার্ড র‍্যান্ডম তৈরি হয় এবং রিপোর রুটে DEV-ACCOUNTS.local.md-তে লেখা হয় (gitignored)।
 * বারবার চালালে একই অ্যাকাউন্ট থাকে, শুধু পাসওয়ার্ড নতুন হয়।
 * ⚠️ প্রোডাকশনে চালাবেন না।
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool, q } from "../src/db";
import { supabaseAdmin } from "../src/supabase";

if (process.env.NODE_ENV === "production") {
  console.error("❌ প্রোডাকশনে dev-accounts চালানো যাবে না।");
  process.exit(1);
}

const pw = () => randomBytes(9).toString("base64url") + "9a";

async function ensureUser(email: string, password: string, role: "admin" | "doctor"): Promise<string> {
  const created = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role },
  });
  if (created.data.user) return created.data.user.id;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (u) {
      const upd = await supabaseAdmin.auth.admin.updateUserById(u.id, { password });
      if (upd.error) throw upd.error;
      return u.id;
    }
    if (data.users.length < 200) break;
  }
  throw new Error(`ইউজার তৈরি করা যায়নি (${email}): ${created.error?.message}`);
}

const admin = { email: "admin@chamberai.test", password: pw() };
const doctors = [
  {
    email: "dr.rahman@chamberai.test",
    password: pw(),
    fullName: "ডা. আব্দুর রহমান (ডেমো)",
    specialty: "মেডিসিন বিশেষজ্ঞ",
    qualifications: "MBBS (ঢাকা মেডিকেল কলেজ), FCPS (মেডিসিন)",
    chamberName: "রহমান মেডিকেল চেম্বার",
    chamberAddress: "বাড়ি ১২, রোড ২৭, ধানমন্ডি, ঢাকা",
    slug: "dr-rahman",
  },
  {
    email: "dr.karim@chamberai.test",
    password: pw(),
    fullName: "ডা. ফারহানা করিম (ডেমো)",
    specialty: "হৃদরোগ বিশেষজ্ঞ",
    qualifications: "MBBS (স্যার সলিমুল্লাহ মেডিকেল কলেজ), MD (কার্ডিওলজি), বাংলাদেশ মেডিকেল বিশ্ববিদ্যালয়",
    chamberName: "করিম হার্ট কেয়ার",
    chamberAddress: "সেকশন ১০, মিরপুর, ঢাকা",
    slug: "dr-karim",
  },
];

const adminId = await ensureUser(admin.email, admin.password, "admin");
await q("insert into public.admins (user_id) values ($1) on conflict do nothing", [adminId]);
console.log(`✅ admin: ${admin.email}`);

for (const d of doctors) {
  const id = await ensureUser(d.email, d.password, "doctor");
  await q(
    `insert into public.doctors (id, email, full_name, specialty, chamber_name, chamber_address, slug, is_open, must_change_password, qualifications)
     values ($1, $2, $3, $4, $5, $6, $7, true, false, $8)
     on conflict (id) do update set full_name = excluded.full_name, specialty = excluded.specialty,
       qualifications = excluded.qualifications,
       chamber_name = excluded.chamber_name, chamber_address = excluded.chamber_address,
       slug = excluded.slug, is_open = true, is_active = true, must_change_password = false`,
    [id, d.email, d.fullName, d.specialty, d.chamberName, d.chamberAddress, d.slug, d.qualifications],
  );
  console.log(`✅ doctor: ${d.email}  →  /d/${d.slug}`);
}

const web = process.env.FRONTEND_URL || "http://localhost:3000";
const out = fileURLToPath(new URL("../DEV-ACCOUNTS.local.md", import.meta.url));
writeFileSync(
  out,
  `# ChamberAI — লোকাল টেস্ট অ্যাকাউন্ট (শুধু ডেভেলপমেন্ট)

> এই ফাইল gitignored। আসল রোগী/ডাক্তারের জন্য ব্যবহার করবেন না।
> নতুন পাসওয়ার্ড লাগলে আবার চালান: \`npm run dev-accounts -w @chamberai/api\`

| ভূমিকা | ইমেইল | পাসওয়ার্ড | লিংক |
|---|---|---|---|
| অ্যাডমিন | ${admin.email} | \`${admin.password}\` | ${web}/login → /admin |
${doctors.map((d) => `| ${d.fullName} | ${d.email} | \`${d.password}\` | ড্যাশবোর্ড: ${web}/login · রোগীর লিংক: ${web}/d/${d.slug} |`).join("\n")}

তৈরি: ${new Date().toISOString()}
`,
  "utf8",
);
console.log(`📄 পাসওয়ার্ডগুলো লেখা হয়েছে: DEV-ACCOUNTS.local.md`);
await pool.end();
