/**
 * প্রথম অ্যাডমিন তৈরি:
 *   npm run create-admin -- --email you@example.com --password "StrongPass123"
 * (রিপোর রুট থেকে চালালে apps/api/.env পড়তে `cd apps/api` করে চালান)
 */
import { pool, q } from "../src/db";
import { supabaseAdmin } from "../src/supabase";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split("=").slice(1).join("=");
}

const email = arg("email");
const password = arg("password");
if (!email || !password || password.length < 8) {
  console.error('ব্যবহার: npm run create-admin -- --email you@example.com --password "অন্তত৮অক্ষর"');
  process.exit(1);
}

let userId: string | null = null;
const created = await supabaseAdmin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  app_metadata: { role: "admin" },
});
if (created.data.user) {
  userId = created.data.user.id;
} else {
  // আগে থেকেই থাকলে খুঁজে বের করা
  for (let page = 1; page <= 20 && !userId; page++) {
    const { data } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    const u = data?.users.find((x: { id: string; email?: string }) => x.email?.toLowerCase() === email.toLowerCase());
    if (u) userId = u.id;
    if (!data || data.users.length < 200) break;
  }
  if (!userId) {
    console.error("অ্যাডমিন তৈরি করা যায়নি:", created.error?.message);
    process.exit(1);
  }
  await supabaseAdmin.auth.admin.updateUserById(userId, { password });
}

await q("insert into public.admins (user_id) values ($1) on conflict do nothing", [userId]);
console.log(`✅ অ্যাডমিন প্রস্তুত: ${email} (${userId})`);
await pool.end();
