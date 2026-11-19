/**
 * নলেজ-বেসের এমবেডিং একবার তৈরি করা (hybrid search-এর vector অংশের জন্য):
 *   cd apps/api && npm run embed-kb
 * দরকার: GEMINI_API_KEY, EMBEDDING_MODEL (AI Studio-তে বর্তমান embedding মডেলের নাম)
 * ফ্রি কোটা বাঁচাতে একসাথে ৫০টি টেক্সট এক রিকোয়েস্টে পাঠানো হয়।
 */
import { pool, q } from "../src/db";
import { embedTexts } from "../src/llm/gemini";

const BATCH = 50;

async function embedTable(table: "kb_drugs" | "kb_symptoms") {
  let total = 0;
  for (;;) {
    const rows = await q<{ id: string; search_text: string }>(
      `select id, search_text from public.${table} where embedding is null limit ${BATCH}`,
    );
    if (!rows.length) break;
    const vectors = await embedTexts(rows.map((r) => r.search_text));
    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (!v?.length) continue;
      await q(`update public.${table} set embedding = $2::vector where id = $1`, [rows[i]!.id, `[${v.join(",")}]`]);
    }
    total += rows.length;
    console.log(`${table}: ${total}`);
  }
}

await embedTable("kb_drugs");
await embedTable("kb_symptoms");
console.log("✅ done");
await pool.end();
